// netlify/functions/tailor.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const FETCH_TIMEOUT_MS = 8500;
const MAX_TOKENS = 1400;

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  if (!OPENAI_API_KEY) return json({ error: 'Missing OPENAI_API_KEY' }, 500);

  const body = await readJson(req);
  const { action } = body || {};
  if (!action) return json({ error: 'Missing action' }, 400);

  if (action === 'analyze') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const score = await scorePair(resume, jd);
    return json({ match_score: score });
  }

  if (action === 'rewrite_full') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);

    const score_v1 = await scorePair(resume, jd);
    const gaps = await findGaps(resume, jd);
    const v2 = await rewritePass(resume, jd, gaps);
    const score_v2 = await scorePair(v2 || resume, jd);
    const missing_after = await findGaps(v2 || resume, jd);

    return json({
      score_v1,
      rewritten_resume_v2: v2 || resume,
      score_v2,
      missing_keywords: missing_after,
      target: 95
    });
  }

  if (action === 'apply_keywords') {
    const { resume = '', jd = '', keywords = [] } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const cleaned = Array.isArray(keywords) ? keywords.map(s => String(s).trim()).filter(Boolean).slice(0, 30) : [];

    const v3 = await applyKeywordsSpread(resume, jd, cleaned);
    const score_v3 = await scorePair(v3 || resume, jd);
    const remaining = await findGaps(v3 || resume, jd);

    return json({
      rewritten_resume: v3 || resume,
      final_score: score_v3,
      remaining_keywords: remaining,
      target: 95
    });
  }

  return json({ error: 'Unknown action' }, 400);
}

/* ---------- Model helpers ---------- */
async function scorePair(resume, jd) {
  const system = [
    'You are an ATS evaluator. Return ONLY JSON: { "match_score": number }.',
    'Score 0-100. Heavily weight exact JD phrase overlap (skills, tools, domains, certifications).',
    'Reward a visible "Skills & Tools Match" section using JD phrases when truthful.',
    'Penalize fluff and claims not present in the resume text.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });
  const data = await openAI({
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
  const data = await openAI({
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
  const data = await openAI({
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
  const data = await openAI({
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
async function openAI(payload) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(()=>'');
      throw new Error(`OpenAI ${res.status}: ${text}`);
    }
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content?.trim() || '{}';
    try { return JSON.parse(content); } catch { return {}; }
  } finally { clearTimeout(t); }
}

function json(body, status=200){
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json' } });
}
async function readJson(req){ try { return JSON.parse(await req.text()); } catch { return {}; } }
function clamp(n, mn, mx, fb=0){ const v = Number(n); return Number.isFinite(v) ? Math.min(mx, Math.max(mn, v)) : fb; }
