// Minimal local models via Transformers.js (no API keys).
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

let embedder=null, generator=null;

export async function initModels(){
  if(!embedder){
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  if(!generator){
    // Small instruct model. First use will download weights (large).
    generator = await pipeline('text-generation', 'Xenova/llama-3.2-1B-instruct');
  }
}

export async function embedTexts(texts){
  const out = await embedder(texts, { normalize:true, pooling:'mean' });
  return Array.isArray(out.data[0]) ? out.data : [out.data];
}

export async function extractJD(jd){
  const prompt = `Extract requirements from the JD. Return strict JSON only with 
{"must_have":[], "nice":[]} . Mark as must_have only items explicitly required (required, must, need).
JD:
${jd}`;
  const res = await generator(prompt, { max_new_tokens:256, temperature:0.2, repetition_penalty:1.1 });
  let text = (res[0]?.generated_text || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  let parsed = { must_have:[], nice:[] };
  try {
    parsed = JSON.parse(m ? m[0] : text);
  } catch{
    // fallback
    const lines = jd.split(/\n|\.|\;|\,/).map(s=>s.trim()).filter(Boolean);
    const kw = lines.filter(s=>/required|must|proficient|experience|with|in/i.test(s)).slice(0,14);
    parsed.must_have = kw.slice(0,8);
    parsed.nice = kw.slice(8,14);
  }
  const clean = t => String(t||'').toLowerCase().replace(/^[\-•\s]+/,'').trim();
  parsed.must_have = [...new Set((parsed.must_have||[]).map(clean).filter(Boolean))];
  parsed.nice = [...new Set((parsed.nice||[]).map(clean).filter(Boolean))];
  return parsed;
}

export async function generateRewrite(resume, jd, jdInfo, scoring, mode='conservative'){
  const sys = `Rewrite the resume to align with the JD without fabricating facts. 
Use action verbs. Include metrics only if present; otherwise add [VERIFY]. Output plain text only.`;
  const guidance = `Must-haves: ${JSON.stringify(jdInfo.must_have)}
Missing: ${JSON.stringify(scoring.missing.must)}
Nice: ${JSON.stringify(jdInfo.nice)}
Evidence score: ${scoring.evidence.points}/20
Mode: ${mode}`;
  const prompt = `${sys}

JOB DESCRIPTION:
${jd}

CURRENT RESUME:
${resume}

GUIDANCE:
${guidance}

Now output the rewritten resume text only:`;
  const res = await generator(prompt, { max_new_tokens: 900, temperature: mode==='aggressive'?0.7:0.2, repetition_penalty:1.1 });
  const rewritten = (res[0]?.generated_text || '').trim();

  const suggPrompt = `Create 5 concise bullet suggestions addressing missing items: ${JSON.stringify(scoring.missing.must.concat(scoring.missing.nice).slice(0,6))}. 
Each bullet must be truthful and include outcomes if available; otherwise add [VERIFY]. Output as plain list.`;
  const s = await generator(suggPrompt, { max_new_tokens: 180, temperature:0.3 });
  const raw = (s[0]?.generated_text || '').trim();
  const suggestions = raw.split(/\n+/).map(x=>x.replace(/^[-•\s]+/,'').trim()).filter(Boolean).slice(0,6);

  return { rewritten, suggestions };
}
