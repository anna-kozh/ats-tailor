// netlify/functions/tailor.js (CommonJS & robust error handling)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const FETCH_TIMEOUT_MS = 8500;
const MAX_TOKENS = 1200;
const MAX_CHARS = 18000; // trim very large pastes to avoid timeouts

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json({ error: 'Use POST' }, 405);
    if (!OPENAI_API_KEY) return json({ error: 'Missing OPENAI_API_KEY' }, 500);

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const action = body.action;

    if (!action) return json({ error: 'Missing action' }, 400);

    if (action === 'analyze') {
      const resume = (body.resume || '').slice(0, MAX_CHARS);
      const jd = (body.jd || '').slice(0, MAX_CHARS);
      if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
      const score = await scorePair(resume, jd);
      return json({ match_score: score });
    }

    if (action === 'rewrite_full') {
      const resume = (body.resume || '').slice(0, MAX_CHARS);
      const jd = (body.jd || '').slice(0, MAX_CHARS);
      if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);

      const score_v1 = await scorePair(resume, jd);
      const gaps = await findGaps(resume, jd);
      const v2 = await rewritePass(resume, jd, gaps);
      const base = v2 || resume;
      const score_v2 = await scorePair(base, jd);
      const missing_after = await findGaps(base, jd);

      return json({
        score_v1,
        rewritten_resume_v2: base,
        score_v2,
        missing_keywords: missing_after,
        target: 95
      });
    }

    if (action === 'apply_keywords') {
      const resume = (body.resume || '').slice(0, MAX_CHARS);
      const jd = (body.jd || '').slice(0, MAX_CHARS);
      const keywords = Array.isArray(body.keywords) ? body.keywords.map(s => String(s).trim()).filter(Boolean).slice(0, 30) : [];
      if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);

      const v3 = await applyKeywordsSpread(resume, jd, keywords);
      const base = v3 || resume;
      const score_v3 = await scorePair(base, jd);
      const remaining = await findGaps(base, jd);

      return json({
        rewritten_resume: base,
        final_score: score_v3,
        remaining_keywords: remaining,
        target: 95
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ error: 'Function crash', detail: String(err && err.message || err) }, 502);
  }
};

/* ---------- Model helpers ---------- */
async function scorePair(resume, jd) {
  const system = [
    'You are an ATS evaluator. Return ONLY JSON: { "match_score": number }.',
    'Score 0-100. Heavily weight exact JD phrase overlap (skills, tools, domains, certifications).',
    'Reward a visible "Skills & Tools Match" section using JD phrases when truthful.',
    'Penalize fluff and claims not present in the resume text.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });
  const data = await openAIStrict({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0,
    response_format: { type: 'json_object' }
  });
  return clamp(Number(data?.match_score), 0, 100, 0);
}

async function findGaps(resume, jd) {
  const system = [
    'Extract concrete JD keywords/phrases that are absent or weak in the resume.',
    'Return ONLY JSON: { "missing_keywords": string[] }. Max 30.',
    'Focus on tools, frameworks, domains, certifications, and exact phrases. No soft skills.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });
  const data = await openAIStrict({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0,
    response_format: { type: 'json_object' }
  });
  const arr = Array.isArray(data?.missing_keywords) ? data.missing_keywords : [];
  return arr.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
}

async function rewritePass(resume, jd, gaps = []) {
  const system = [
    'Expert ATS resume tailor. Maximize truthful overlap with the JD without fabrication.',
    'Rewrite into concise, metric-heavy bullets; keep employers and dates intact.',
    'Include a short top section "Skills & Tools Match" listing exact JD phrases you can truly claim.',
    gaps.length ? `Weave in these JD terms where truthful: ${gaps.join(', ')}.` : 'Only use what is supported by the resume.',
    'Return ONLY JSON: { "rewritten_resume": string }.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });
  const data = await openAIStrict({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS
  });
  return String(data?.rewritten_resume || '').trim();
}

async function applyKeywordsSpread(resume, jd, keywords = []) {
  const system = [
    'You are an expert resume editor. Integrate the provided JD keywords TRUTHFULLY and NATURALLY,',
    'spreading them across the document instead of jamming them into Skills.',
    'Rules: keep employers/titles/dates intact; add a short Skills section if missing;',
    'distribute keywords across recent roles by revising up to 2 bullets per role and adding a concise "Tools:" line with exact names;',
    'avoid keyword stuffing; if a keyword cannot be truthfully added, skip it.',
    'Return ONLY JSON: { "rewritten_resume": string }.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd, keywords });
  const data = await openAIStrict({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS
  });
  return String(data?.rewritten_resume || '').trim();
}

/* ---------- HTTP & Util ---------- */
async function openAIStrict(payload) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text}`);
    let content = text;
    try {
      const j = JSON.parse(text);
      content = j?.choices?.[0]?.message?.content?.trim() || '{}';
    } catch {}
    try { return JSON.parse(content); } catch { return {}; }
  } finally { clearTimeout(t); }
}

function json(body, statusCode=200){
  return { statusCode, headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) };
}
function clamp(n, mn, mx, fb=0){ const v = Number(n); return Number.isFinite(v) ? Math.min(mx, Math.max(mn, v)) : fb; }
