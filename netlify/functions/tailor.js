// netlify/functions/tailor.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const FETCH_TIMEOUT_MS = 8500;
const MAX_TOKENS_REWRITE = 1400;

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

  // single-pass rewrite; client can loop up to 3 passes
  if (action === 'rewrite') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const gaps = await findGaps(resume, jd);
    const rewritten = await rewritePass(resume, jd, gaps);
    const score = await scorePair(rewritten || resume, jd);
    return json({ rewritten_resume: rewritten || resume, final_score: score });
  }

  return json({ error: 'Unknown action' }, 400);
}

/** ---- helpers ---- */
async function scorePair(resume, jd) {
  const system = [
    'You are an ATS evaluator. Return JSON only: { "match_score": number }.',
    'Score 0-100. Heavily weight exact JD phrase overlap (skills, tools, domains, certifications).',
    'Reward a visible "Skills & Tools Match" section using JD phrases when truthful.',
    'Penalize fluff or claims not present in the text. Do not infer unstated skills.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });
  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0,
    top_p: 1,
    response_format: { type: 'json_object' }
  });
  return clamp(Number(data?.match_score), 0, 100, 0);
}

async function findGaps(resume, jd) {
  const system = [
    'Extract concrete JD keywords/phrases absent or weak in the resume.',
    'Return JSON only: { "missing_keywords": string[] }. Max 30.',
    'Focus on hard skills, tools, frameworks, domains, and exact phrases.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });
  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0,
    top_p: 1,
    response_format: { type: 'json_object' }
  });
  const arr = Array.isArray(data?.missing_keywords) ? data.missing_keywords : [];
  return arr.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
}

async function rewritePass(resume, jd, gaps = []) {
  const system = [
    'You are an expert ATS resume tailor. Goal: maximize truthful keyword/phrase overlap with the JD.',
    'Rewrite into a concise, metric-heavy resume (≤1200 words).',
    'Insert a short top section titled "Skills & Tools Match" that lists exact JD keywords you can truthfully claim.',
    'Use exact JD phrasing naturally in bullets and headings; no obvious keyword stuffing.',
    'Prefer active verbs and quant results; keep employers and dates intact.',
    gaps.length ? `Prioritize weaving these JD terms (only if truthful): ${gaps.join(', ')}.`
                : 'Use only what can be reasonably inferred from the original. Do not invent experience.',
    'Return JSON only: { "rewritten_resume": string }.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });
  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.4,
    top_p: 1,
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS_REWRITE
  });
  return String(data?.rewritten_resume || '').trim();
}

async function openAI(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${t}`);
    }
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content?.trim() || '{}';
    try { return JSON.parse(content); } catch { return {}; }
  } finally {
    clearTimeout(timeout);
  }
}

function json(body, status=200){
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function readJson(req){ try { return JSON.parse(await req.text()); } catch { return {}; } }
function clamp(n, min, max, fb=0){ const v = Number(n); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb; }
