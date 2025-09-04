// netlify/functions/tailor.mjs
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const FETCH_TIMEOUT_MS = 20000; // 20s; single call per action to avoid timeouts

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  if (!OPENAI_API_KEY) return json({ error: 'Missing OPENAI_API_KEY' }, 500);

  const body = await readJson(req);
  const { action } = body || {};
  if (!action) return json({ error: 'Missing action' }, 400);

  if (action === 'analyze') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const analysis = await analyzeResume(resume, jd);
    return json(analysis);
  }

  if (action === 'rewrite') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const result = await rewriteAndScore(resume, jd);
    // Fallback to original resume if model failed
    if (!result.rewritten_resume || !String(result.rewritten_resume).trim()) {
      result.rewritten_resume = resume;
    }
    return json({ rewritten_resume: result.rewritten_resume, final_score: clamp(Number(result.match_score),0,100,0) });
  }

  return json({ error: 'Unknown action' }, 400);
}

/** Analyze only */
async function analyzeResume(resume, jd) {
  const system = [
    'You are an ATS evaluator.',
    'Return json only with: { "match_score": number }.',
    'Score strictly from 0-100 based on JD alignment; do not reward absent skills.'
  ].join(' ');
  const user = JSON.stringify({ resume, jd });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' }
  });

  return { match_score: clamp(Number(data.match_score), 0, 100, 0) };
}

/** Rewrite aggressively and self-score in one call to reduce timeouts */
async function rewriteAndScore(resume, jd) {
  const system = [
    'You are an expert resume tailor.',
    'Goal: aggressively rewrite the resume to maximize ATS match to the JD.',
    'Rules: no fabrication; preserve original tone; fix grammar/typos; concise; prioritize <= 2 US Letter pages (~1100-1200 words).',
    'Return json only with: { "rewritten_resume": string, "match_score": number }.',
    'Compute match_score (0-100) for the rewritten resume vs the JD.'
  ].join(' ');

  const user = JSON.stringify({ resume, jd });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.5,
    response_format: { type: 'json_object' },
    max_tokens: 1800
  });

  return {
    rewritten_resume: typeof data.rewritten_resume === 'string' ? data.rewritten_resume : '',
    match_score: clamp(Number(data.match_score), 0, 100, 0)
  };
}

/** OpenAI helper with timeout */
async function openAI(payload) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${await res.text().catch(()=>'')}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content?.trim() || '{}';
    return JSON.parse(content);
  } catch (err) {
    // Surface clean error message
    throw new Error(err?.message || String(err));
  } finally {
    clearTimeout(t);
  }
}

/** utils */
function json(body, status=200){
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function readJson(req){ const t = await req.text(); try{ return JSON.parse(t||'{}'); } catch { return {}; } }
function clamp(n, min, max, fb=0){ const v = Number(n); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb; }
