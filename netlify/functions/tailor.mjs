// netlify/functions/tailor.mjs
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const FETCH_TIMEOUT_MS = 25000;
const MAX_TOKENS_REWRITE = 1400;

// new: target + safety caps
const TARGET_SCORE = 95;
const MAX_PASSES = 6;

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

    // new: iterate until target
    const { text, score, iterations } = await rewriteToTarget(resume, jd, TARGET_SCORE, MAX_PASSES);
    return json({
      rewritten_resume: text || resume,
      final_score: Number.isFinite(score) ? score : 0,
      iterations,
      target: TARGET_SCORE
    });
  }

  return json({ error: 'Unknown action' }, 400);
}

/** Score 0–100 */
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

/** Find missing JD keywords relative to the resume */
async function findGaps(resume, jd) {
  const system = [
    'You extract ATS-relevant keywords that are present in the JD but absent or weak in the resume.',
    'Return json only: { "missing_keywords": string[] }.',
    'Include exact phrases and skills from the JD. Max 30 items. No soft fluff.'
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

/** Single rewrite pass, optionally guided by gaps */
async function rewritePass(resume, jd, gaps = []) {
  const system = [
    'You are an expert resume tailor. Rewrite aggressively for ≥95 alignment without fabrication.',
    'Preserve tone, fix grammar, keep concise (≤2 US Letter pages ~1100–1200 words).',
    'Prioritize explicit JD must-have keywords and measurable impact.',
    gaps.length
      ? `If TRUE for the candidate, naturally weave in these JD terms: ${gaps.join(', ')}. Do NOT invent experience.`
      : 'Use only information that could reasonably be inferred from the original wording; do not invent experience.',
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

/** Loop until target score or passes exhausted */
async function rewriteToTarget(resume, jd, target = 95, maxPasses = 6) {
  let attempt = String(resume || '');
  let bestText = attempt;
  let bestScore = await scorePair(bestText, jd);
  let i = 0;

  for (; i < maxPasses && bestScore < target; i++) {
    const gaps = await findGaps(bestText, jd);
    const next = await rewritePass(bestText, jd, gaps);
    const nextScore = await scorePair(next || bestText, jd);

    if (Number(nextScore) >= Number(bestScore)) {
      bestText = next || bestText;
      bestScore = nextScore;
    } else {
      // if it regresses, still continue once more with fresh gaps
      bestText = next || bestText;
      bestScore = nextScore;
    }
  }
  return { text: bestText, score: bestScore, iterations: Math.max(1, i) };
}

/** OpenAI helper */
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
