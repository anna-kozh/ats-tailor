// netlify/functions/tailor.mjs
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const FETCH_TIMEOUT_MS = 25000;
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

  if (action === 'rewrite') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const rewritten = await rewritePass(resume, jd);
    const score = await scorePair(rewritten || resume, jd);
    return json({ rewritten_resume: rewritten || resume, final_score: score });
  }

  return json({ error: 'Unknown action' }, 400);
}

async function scorePair(resume, jd) {
  const system = [
    'You are an ATS evaluator. Output json only: { "match_score": number }.',
    '0-100 scale; prioritize explicit JD must-haves and exact phrases; no hallucination.'
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

async function rewritePass(resume, jd) {
  const system = [
    'You are an expert resume tailor. Rewrite aggressively for ≥95 alignment without fabrication.',
    'Preserve tone, fix grammar/typos, keep concise (≤2 US Letter pages ~1100–1200 words).',
    'Prioritize explicit JD must-have keywords and measurable impact.',
    'Return json only: { "rewritten_resume": string }.'
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
  const t = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${text}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content?.trim() || '{}';
    try { return JSON.parse(content); } catch { return {}; }
  } finally {
    clearTimeout(t);
  }
}

function json(body, status=200){ return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
async function readJson(req){ try { return JSON.parse(await req.text()); } catch { return {}; } }
function clamp(n, min, max, fb=0){ const v = Number(n); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb; }
