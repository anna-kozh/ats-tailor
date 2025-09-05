// netlify/functions/rewrite.mjs (OpenAI with 8s abort + graceful fallback)
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DRY_RUN = process.env.DRY_RUN === 'true';

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// --- keyword utils ---
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
  const required = new Set(sorted.slice(0, 24)); // smaller to speed up
  const nice = new Set(sorted.slice(24, 48));
  const tech = new Set(sorted.filter(t => /[0-9/#.+\-]/.test(t) || t.length > 6).slice(0, 20));
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

  // Overstuffing penalty (naive): >9 repeats
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

function makeFallbackV2(resume, jdKeywords){
  // Deterministic local fallback so we never 504
  const top = [...jdKeywords.required].slice(0,10);
  const skills = top.slice(0,8).join(', ');
  const objective = `Objective\nLead Product Designer aligned to JD: ${top.slice(0,6).join(', ')}.`;
  return `${objective}\n\nSkills\n${skills}\n\n${resume}`;
}

function trimJD(jd){
  const maxChars = 800; // even smaller to guarantee speed
  if (jd.length <= maxChars) return jd;
  const reqMatch = jd.match(/(Requirements|What you'll do|Responsibilities|About you)[\s\S]{0,800}/i);
  return reqMatch ? reqMatch[0] : jd.slice(0, maxChars);
}

async function rewriteWithOpenAI({resume, jd, jdKeywords}){
  if (!client) throw new Error('OPENAI_API_KEY missing');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s hard stop

  try{
    const guide = { sectionHeaders: ['Objective','Skills','Experience','Education'] };
    const jdShort = trimJD(jd);
    const sys = `You are an expert resume editor for ATS. Do not invent employers, dates, or degrees. You may add keywords into objective, skills, and bullet responsibilities. Keep text truthful and concise. Use plain text with clear section headers that the ATS recognizes: ${guide.sectionHeaders.join(', ')}. Avoid keyword stuffing; spread terms naturally.`;
    const user = [
      `JOB DESCRIPTION (trimmed):\n${jdShort}\n`,
      `CURRENT RESUME:\n${resume}\n`,
      `TARGET KEYWORDS (sample): ${[...jdKeywords.required].slice(0,18).join(', ')}\n`,
      `GOAL: Rewrite to improve match; keep titles/chronology; output plain text with sections: ${guide.sectionHeaders.join(' > ')}.`
    ].join('\n');

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      timeout: 8000,
      signal: controller.signal
    });

    return completion.choices?.[0]?.message?.content?.trim() || "";
  } finally {
    clearTimeout(timer);
  }
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

    const scoreV1 = scoreText(resume, jdKeywords, roleTerms);

    let v2Text = "";
    let mode = "openai";
    if (DRY_RUN) {
      mode = "dryRun";
      v2Text = makeFallbackV2(resume, jdKeywords);
    } else {
      try{
        v2Text = await rewriteWithOpenAI({ resume, jd, jdKeywords });
        if (!v2Text) throw new Error("empty_openai_output");
      } catch (e){
        // Graceful fallback to avoid 504
        mode = "timeoutFallback";
        v2Text = makeFallbackV2(resume, jdKeywords);
      }
    }

    const scoreV2 = scoreText(v2Text, jdKeywords, roleTerms);
    const boldedV2 = boldAddedKeywords(resume, v2Text, jdKeywords);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v2Text, scoreV1, scoreV2, boldedV2, mode })
    };
  } catch (err){
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
}
