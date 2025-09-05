// OpenAI rewrite via RESPONSES API (with 8s timeout), calibrated scoring,
// bolded additions, and local fallback + debug.

import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/* ---------------- keyword + scoring utils ---------------- */

const STOPWORDS = new Set(
  `a an the and or but of in on at for with from by as is are was were be been
   being to your you we they it this that these those how what where when which
   who whom whose why will would could should can may might must than then so
   such via per about-based using through within i me my mine our ours us them
   their he she her his its you're you'll you've i've we'll we're it's ll ve re
   dont don't isnt isn't cant can't won't wouldnt couldn't shouldn't arent aren't
   had has have do does did doing done every each either neither both few many
   much most more some any other another only own same just still even very first
   last new fast slow high low more less make move work ship back always often
   across value values experience experiences people teams team projects project
   decision decisions time basic basics doing culture`.split(/\s+/)
);
const GENERIC_JUNK = new Set(
  `across experience experiences value values people teams team projects project
   decisions decision basic basics doing culture`.split(/\s+/)
);

function normTokens(text){
  return (text||"").toLowerCase().replace(/[^a-z0-9+/#.&\- \n]/g," ")
    .split(/\s+/).filter(Boolean);
}
function tokenize(t){ return normTokens(t).filter(x=>!STOPWORDS.has(x)); }
function bigrams(tokens){
  const out=[]; for(let i=0;i<tokens.length-1;i++){
    const a=tokens[i], b=tokens[i+1];
    if(!a||!b) continue; if(GENERIC_JUNK.has(a)||GENERIC_JUNK.has(b)) continue;
    if(a.length<3||b.length<3) continue; out.push(`${a} ${b}`);
  } return out;
}
function extractKeywords(jd){
  const toks = tokenize(jd);
  const uni = {}; for(const t of toks){ if(!GENERIC_JUNK.has(t)&&t.length>=4) uni[t]=(uni[t]||0)+1; }
  const bi = {}; for(const bg of bigrams(toks)) bi[bg]=(bi[bg]||0)+1;

  const singles = Object.entries(uni).sort((a,b)=>b[1]-a[1]).map(([t])=>t);
  const bis = Object.entries(bi).sort((a,b)=>b[1]-a[1]).map(([t])=>t);

  const shortJD = jd.length < 1500;
  const reqCount = shortJD ? 12 : 24;
  const niceCount = shortJD ? 18 : 36;
  const techCount = 15;

  const required = new Set([...bis.slice(0, Math.min(6, Math.floor(reqCount/2))), ...singles.slice(0, reqCount)]);
  const nice = new Set([...bis.slice(6, 6+Math.floor(niceCount/2)), ...singles.slice(reqCount, reqCount+niceCount)]);
  const tech = new Set(singles.filter(t => /[0-9/#.+\-]/.test(t) || t.includes('figma') || t.includes('design') || t.includes('system') || t.includes('ai')).slice(0, techCount));
  return { required, nice, tech, all: new Set([...required, ...nice, ...tech]) };
}

function scoreText(text, jdKeywords, roleTerms=[]){
  const tokens = new Set(normTokens(text));
  const reqTotal = jdKeywords.required.size || 1;
  let reqHit=0; for(const term of jdKeywords.required){
    if(term.includes(' ')){ if(text.toLowerCase().includes(term)) reqHit++; }
    else if(tokens.has(term)) reqHit++;
  }
  const niceTotal = jdKeywords.nice.size || 1;
  let niceHit=0; for(const term of jdKeywords.nice){
    if(term.includes(' ')){ if(text.toLowerCase().includes(term)) niceHit++; }
    else if(tokens.has(term)) niceHit++;
  }
  const roleTotal = roleTerms.length||1; let roleHit=0; for(const t of roleTerms) if(tokens.has(t)) roleHit++;
  const techTotal = jdKeywords.tech.size||1; let techHit=0; for(const t of jdKeywords.tech) if(tokens.has(t)) techHit++;

  let s = (reqHit/reqTotal)*70 + (niceHit/niceTotal)*15 + (roleHit/roleTotal)*10 + (techHit/techTotal)*5;
  const counts={}; for(const t of normTokens(text)) counts[t]=(counts[t]||0)+1;
  for(const [,c] of Object.entries(counts)) if(c>12) s-=Math.min(5,c-12);
  return Math.max(0, Math.min(100, s));
}

function escapeHtml(s){ return (s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function boldAddedKeywords(v1,v2,jdKeywords){
  let out = escapeHtml(v2);
  const v1L = v1.toLowerCase();
  const bigs = [...jdKeywords.all].filter(t=>t.includes(' ')).sort((a,b)=>b.length-a.length);
  for(const bg of bigs){ if(!v1L.includes(bg)){ const re=new RegExp(bg.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'); out=out.replace(re,m=>`**${m}**`); } }
  const v1Set=new Set(normTokens(v1));
  const singles=[...jdKeywords.all].filter(t=>!t.includes(' ')).sort((a,b)=>b.length-a.length);
  if(singles.length){
    const re=new RegExp(`\\b(${singles.filter(s=>!v1Set.has(s)).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})\\b`,'gi');
    out=out.replace(re,m=>`**${m}**`);
  }
  return out;
}
function trimJD(jd){
  const max=1000; if(jd.length<=max) return jd;
  const m=jd.match(/(Requirements|What you'll do|Responsibilities|About you)[\s\S]{0,1000}/i);
  return m?m[0]:jd.slice(0,max);
}
function makeFallbackV2(resume,jdKeywords){
  const req=[...jdKeywords.required].slice(0,8);
  const nice=[...jdKeywords.nice].slice(0,6);
  const values=req.concat(nice).filter(t=>t.includes('accessib')||t.includes('accountab')||t.includes('resilien')||t.includes('ship fast')||t.includes('design system')||t.includes('patient'));
  const obj=`Objective\nLead Product Designer aligned to JD priorities: ${req.slice(0,6).join(', ')}.`;
  const skills=`\n\nSkills\n${req.concat(nice).slice(0,10).join(', ')}`;
  const vals=values.length?`\n\nValues alignment\n- ${values.join('\n- ')}`:'';
  return `${obj}${skills}${vals}\n\n${resume}`;
}

/* ------------------------ OpenAI (Responses API) ---------------------- */

async function rewriteWithOpenAI({ resume, jd, jdKeywords }){
  if(!client) throw new Error("OPENAI_API_KEY missing");
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 8000);
  try{
    const guide={sectionHeaders:["Objective","Skills","Experience","Education"]};
    const sys =
      `You are an expert resume editor for ATS. Do not invent employers, dates, or degrees. ` +
      `Add missing keywords only in objective, skills, and bullet responsibilities. ` +
      `Use plain text with clear section headers (${guide.sectionHeaders.join(", ")}). ` +
      `Avoid keyword stuffing; spread terms naturally.`;

    const prompt =
      `SYSTEM:\n${sys}\n\n` +
      `JOB DESCRIPTION (trimmed):\n${trimJD(jd)}\n\n` +
      `CURRENT RESUME:\n${resume}\n\n` +
      `KEY TERMS (bigrams first): ${[...jdKeywords.required].slice(0,14).join(", ")}\n\n` +
      `GOAL: Improve match. Keep titles & chronology. Output plain text resume with sections: ${guide.sectionHeaders.join(" > ")}.\n` +
      `If JD includes values (e.g., accessibility, accountability, resilience, "ship fast"), reflect them briefly without fabricating achievements.`;

    const resp = await client.responses.create(
      { model: MODEL, input: prompt, temperature: 0.2, max_output_tokens: 650 },
      { timeout: 8000, signal: controller.signal } // <-- options go here
    );

    const text =
      (resp.output_text && resp.output_text.trim()) ||
      (resp.output?.[0]?.content?.[0]?.text?.value || "").trim();

    return text;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------- handler ----------------------------- */

export async function handler(event){
  if(event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let debug = { dryRun: DRY_RUN, hasKey: !!OPENAI_API_KEY };

  try{
    const { resume, jd } = JSON.parse(event.body || "{}");
    if(!resume || !jd) return { statusCode: 400, body: JSON.stringify({ error: "Missing resume or jd" }) };

    const jdKeywords = extractKeywords(jd);
    const roleTerms = ["lead","senior","staff","designer","product","ux","ui","system","strategy"];

    const scoreV1 = scoreText(resume, jdKeywords, roleTerms);

    let v2Text = "";
    let mode = "openai";

    if (DRY_RUN){
      mode = "dryRun";
      v2Text = makeFallbackV2(resume, jdKeywords);
    } else {
      try{
        v2Text = await rewriteWithOpenAI({ resume, jd, jdKeywords });
        if (!v2Text) throw new Error("empty_openai_output");
      } catch(e){
        mode = "timeoutFallback";
        v2Text = makeFallbackV2(resume, jdKeywords);
        debug.reason = String(
          e?.response?.data?.error?.message ||
          e?.status || e?.statusText || e?.code || e?.message || "unknown"
        );
      }
    }

    const scoreV2 = scoreText(v2Text, jdKeywords, roleTerms);
    const boldedV2 = boldAddedKeywords(resume, v2Text, jdKeywords);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v2Text, scoreV1, scoreV2, boldedV2, mode, debug })
    };
  } catch(err){
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || String(err), debug }) };
  }
}
