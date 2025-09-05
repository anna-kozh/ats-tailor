// netlify/functions/rewrite.mjs
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Keyword extraction + scoring ---
const STOPWORDS = new Set(`a an the and or but of in on at for with from by as is are was were be been being to your you we they it this that these those how what where when which who whom whose why will would could should can may might must than then so such via per about-based using through within i me my mine our ours us them their they he she her his its your you're you'll you've i've we'll we're it's ll ve re dont don't isnt isn't cant can't won't wouldnt couldn't shouldn't arent aren't had has have do does did doing done every each either neither both few many much most more some any other another only own same just still even very first last new fast slow high low more less make move work ship back always often`.split(/\s+/));

function tokenize(text){
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9+/#.&\- ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function extractKeywords(jd){
  const toks = tokenize(jd).filter(t => !STOPWORDS.has(t));
  const freq = new Map();
  for(const t of toks){ freq.set(t, (freq.get(t)||0) + 1); }
  const sorted = [...freq.entries()].sort((a,b)=>b[1]-a[1]).map(([t])=>t);
  const required = new Set(sorted.slice(0, 40));
  const nice = new Set(sorted.slice(40, 80));
  const tech = new Set(sorted.filter(t => /[0-9/#.+\-]/.test(t) || t.length > 6).slice(0, 30));
  return { required, nice, tech, all: new Set([...required, ...nice, ...tech]) };
}

function scoreText(text, jdKeywords, roleTerms=[]){
  const tokens = new Set(tokenize(text));
  const totalReq = jdKeywords.required.size || 1;
  let coveredReq = 0;
  for(const term of jdKeywords.required){ if(tokens.has(term)) coveredReq++; }

  const niceTotal = jdKeywords.nice.size || 1;
  let niceHit = 0;
  for(const term of jdKeywords.nice){ if(tokens.has(term)) niceHit++; }

  const roleTotal = roleTerms.length || 1;
  let roleHit = 0;
  for(const term of roleTerms){ if(tokens.has(term)) roleHit++; }

  const techTotal = jdKeywords.tech.size || 1;
  let techHit = 0;
  for(const term of jdKeywords.tech){ if(tokens.has(term)) techHit++; }

  let computed = (coveredReq/totalReq)*60 + (niceHit/niceTotal)*20 + (roleHit/roleTotal)*10 + (techHit/techTotal)*10;

  // Overstuffing penalty (naive): >9 repeats of same token
  const counts = {};
  for(const t of tokenize(text)){ counts[t] = (counts[t]||0)+1; }
  for(const [t,c] of Object.entries(counts)){
    if(c > 9) computed -= Math.min(5, c-9);
  }
  return Math.max(0, Math.min(100, computed));
}

function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function boldAddedKeywords(v1, v2, jdKeywords){
  const v1Set = new Set(tokenize(v1));
  const target = new Set([...jdKeywords.all].filter(t => !v1Set.has(t)));
  if (target.size === 0) return escapeHtml(v2);
  const esc = escapeHtml(v2);
  const sorted = [...target].sort((a,b)=>b.length-a.length).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (sorted.length === 0) return esc;
  const re = new RegExp(`\\b(${sorted.join('|')})\\b`, 'gi');
  return esc.replace(re, (m) => `**${m}**`);
}

function atsGuidelines(){
  // Generic ATS-friendly structure
  return { sectionHeaders: ['Objective','Skills','Experience','Education'] };
}

// --- OpenAI rewrite loop ---
async function rewriteOnce({resume, jd, jdKeywords}){
  const guide = atsGuidelines();
  const sys = `You are an expert resume editor for ATS. Do not invent employers, dates, or degrees. You may add keywords into objective, skills, and bullet responsibilities. Keep text truthful and concise. Use plain text with clear section headers that the ATS recognizes: ${guide.sectionHeaders.join(', ')}. Keep bullets concise. Avoid keyword stuffing; spread terms in objective, skills, and bullets.`;

  const user = [
    `JOB DESCRIPTION:\n${jd}\n`,
    `CURRENT RESUME:\n${resume}\n`,
    `TARGET KEYWORDS (sample): ${[...jdKeywords.required].slice(0,20).join(', ')}\n`,
    `REWRITE GOAL:\n- Improve match and reach >=95 proxy score\n- Keep titles, chronology, achievements\n- Add missing JD keywords naturally where relevant\n- Do not fabricate employers, dates, or education\n- Output plain text resume with sections in this order: ${guide.sectionHeaders.join(' > ')}\n`
  ].join('\n');

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

export async function handler(event){
  try{
    if(event.httpMethod !== 'POST'){
      return { statusCode: 405, body: 'Method Not Allowed' };
    }
    const { resume, jd } = JSON.parse(event.body||'{}');
    if(!resume || !jd){
      return { statusCode: 400, body: JSON.stringify({ error: "Missing resume or jd" }) };
    }

    const jdKeywords = extractKeywords(jd);
    const roleTerms = ['lead','senior','staff','designer','product','ux','ui','system','strategy'];

    // Score v1
    const scoreV1 = scoreText(resume, jdKeywords, roleTerms);

    // Iterate up to 3 times to reach >=95
    let v2Text = "";
    let scoreV2 = 0;
    let attempt = 0;
    let input = resume;

    while(attempt < 3){
      attempt++;
      const draft = await rewriteOnce({ resume: input, jd, jdKeywords });
      v2Text = draft || input;
      scoreV2 = scoreText(v2Text, jdKeywords, roleTerms);

      // anti-stuffing: if adding keywords tank readability (heuristic), trim repeated lines
      if (scoreV2 < 95){
        // remove duplicate consecutive lines as a small cleanup
        const lines = v2Text.split(/\r?\n/);
        const cleaned = lines.filter((l,i,arr)=> i===0 || l.trim() !== arr[i-1].trim()).join('\n');
        input = cleaned;
      } else {
        break;
      }
    }

    const boldedV2 = boldAddedKeywords(resume, v2Text, jdKeywords);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v2Text, scoreV1, scoreV2, boldedV2, attempts: attempt })
    };
  } catch (err){
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
}
