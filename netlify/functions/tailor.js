// netlify/functions/tailor.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const FETCH_TIMEOUT_MS = 10000;
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

    const gaps = await findGaps(resume, jd);
    const rewritten = await rewritePass(resume, jd, gaps);
    const score = await scorePair(rewritten || resume, jd);
    const missingAfter = await findGaps(rewritten || resume, jd);

    return json({
      rewritten_resume: rewritten || resume,
      final_score: score,
      missing_keywords: missingAfter,
      suggested_skills_section: buildSuggestedSkillsBlock(missingAfter)
    });
  }

  if (action === 'approve') {
    const { resume_v2 = '', jd = '', approved_keywords = [] } = body || {};
    if (!resume_v2 || !jd) return json({ error: 'Missing resume_v2 or jd' }, 400);

    let working = resume_v2;
    let score = await scorePair(working, jd);
    let missing = await findGaps(working, jd);

    // Merge user-approved keywords first
    let seed = Array.isArray(approved_keywords) ? approved_keywords : [];

    // Try up to 3 passes to reach >=95
    for (let i = 0; i < 3 && score < 95; i++) {
      const gaps = Array.from(new Set([...(seed||[]), ...(missing||[])])).slice(0, 30);
      working = await rewritePass(working, jd, gaps);
      score = await scorePair(working, jd);
      missing = await findGaps(working, jd);
    }

    return json({
      final_resume: working,
      final_score: score,
      missing_keywords_after: missing.slice(0, 24)
    });
  }

  return json({ error: 'Unknown action' }, 400);
}

/** ----- helpers ----- */
async function scorePair(resume, jd) {
  const system = [
    'You are an ATS evaluator. Return ONLY JSON: { "match_score": number }.',
    'Score 0-100. Heavily weight exact JD phrase overlap (skills, tools, domains, certifications).',
    'Reward a "Skills & Tools Match" section using exact JD phrases when truthful.',
    'Penalize claims not present in the resume text.'
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
    'Extract concrete, ATS-relevant JD keywords/phrases that are absent or weak in the resume.',
    'Return ONLY JSON: { "missing_keywords": string[] }.',
    'Max 30 items. Focus on hard skills, tools, domains, frameworks, certifications, exact phrases.',
    'No soft skills. No hallucinations.'
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
    'You are an expert ATS resume tailor. Maximize truthful overlap with the JD without fabrication.',
    'Rewrite into a concise, metric-heavy resume (≤1200 words).',
    'Include a short top section titled "Skills & Tools Match" listing exact JD phrases you can truthfully claim.',
    'Use exact JD phrasing naturally in bullets and headings; avoid obvious keyword stuffing.',
    'Keep employers and dates intact; edit wording for clarity and impact.',
    gaps.length ? `Prioritize weaving these JD terms (only if truthful): ${gaps.join(', ')}.`
                : 'Use only what is reasonably inferable from the original; do not invent experience.',
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
    top_p: 1,
    response_format: { type: 'json_object' },
    max_tokens: MAX_TOKENS_REWRITE
  });
  return String(data?.rewritten_resume || '').trim();
}

function buildSuggestedSkillsBlock(missingKeywords = []) {
  if (!Array.isArray(missingKeywords) || missingKeywords.length === 0) return '';
  const list = [...new Set(missingKeywords)].slice(0, 24).join(' · ');
  return `Skills & Tools Match:\n${list}`;
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
