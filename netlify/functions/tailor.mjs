const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const FETCH_TIMEOUT_MS = 10000;

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const body = await readJson(req);
  const { action } = body || {};
  if (!action) return json({ error: 'Missing action' }, 400);

  if (action === 'analyze') {
    const { resume = '', jd = '' } = body || {};
    const result = await analyzeResume(resume, jd);
    return json(result);
  }

  if (action === 'rewrite') {
    const { resume = '', jd = '' } = body || {};
    const rewritten = await rewriteResume(resume, jd);
    const scored = await analyzeResume(rewritten.rewritten_resume, jd);
    return json({ ...rewritten, final_score: scored.match_score });
  }

  return json({ error: 'Unknown action' }, 400);
}

async function analyzeResume(resume, jd) {
  const sys = 'You are an ATS evaluator. Output json only with: { "match_score": number }';
  const user = JSON.stringify({ resume, jd });
  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });
  return { match_score: Math.min(100, Math.max(0, Number(data.match_score || 0))) };
}

async function rewriteResume(resume, jd) {
  const sys = `You are an expert resume tailor.
- Rewrite the resume aggressively to maximize ATS match with the job description.
- Target a 100% match but DO NOT invent false experience.
- Preserve the tone and style of the original resume.
- Fix typos and grammar, but keep user's voice.
- Keep resume concise, prioritize keeping under 2 US letter pages (~1100-1200 words).
- Output json only: { "rewritten_resume": string }`;
  const user = JSON.stringify({ resume, jd });
  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    temperature: 0.5,
    response_format: { type: 'json_object' },
    max_tokens: 2000
  });
  return { rewritten_resume: data.rewritten_resume || resume };
}

async function openAI(payload) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    return JSON.parse(json?.choices?.[0]?.message?.content || '{}');
  } finally {
    clearTimeout(t);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
async function readJson(req) {
  try { return JSON.parse(await req.text()); } catch { return {}; }
}