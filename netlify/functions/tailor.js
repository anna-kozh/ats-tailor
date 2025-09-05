// netlify/functions/tailor.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const FETCH_TIMEOUT_MS = 30000; // 30s general

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  if (!OPENAI_API_KEY) return json({ error: 'Missing OPENAI_API_KEY' }, 500);

  const body = await readJson(req);
  const { action } = body || {};
  if (!action) return json({ error: 'Missing action' }, 400);

  if (action === 'analyze') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    try {
      // Fast path with strict limits
      const score = await scorePairFast(resume, jd);
      return json({ match_score: score });
    } catch (e) {
      // Local fallback under 10s Netlify limit
      const score = localSimilarity(resume, jd);
      return json({ match_score: score, fallback: true });
    }
  }

  if (action === 'rewrite') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const gaps = await findGaps(resume, jd);
    let rewritten = await rewritePass(resume, jd, gaps);
    rewritten = sanitizeResume(rewritten);
    const score = await scorePair(rewritten || resume, jd);
    const missingAfter = await findGaps(rewritten || resume, jd);
    return json({
      rewritten_resume: rewritten || resume,
      final_score: score,
      missing_keywords: missingAfter
    });
  }

  if (action === 'approve') {
    const { resume_v2 = '', jd = '', approved_keywords = [] } = body || {};
    if (!resume_v2 || !jd) return json({ error: 'Missing resume_v2 or jd' }, 400);

    const initialMissing = await findGaps(resume_v2, jd);
    const merged = Array.from(new Set([...(approved_keywords||[]), ...initialMissing])).slice(0, 30);

    let working = sanitizeResume(await rewritePass(resume_v2, jd, merged));
    let score = await scorePair(working, jd);

    if (score < 95) {
      const secondMissing = await findGaps(working, jd);
      const merged2 = Array.from(new Set([...(approved_keywords||[]), ...secondMissing])).slice(0, 30);
      working = sanitizeResume(await rewritePass(working, jd, merged2));
      score = await scorePair(working, jd);
    }
    const after = await findGaps(working, jd);
    return json({ final_resume: working, final_score: score, missing_keywords_after: after.slice(0,24) });
  }

  return json({ error: 'Unknown action' }, 400);
}

/** ----- helpers ----- */
function trimMiddle(str, maxChars = 8000) {
  if (str.length <= maxChars) return str;
  const half = Math.floor(maxChars / 2);
  return str.slice(0, half) + "\n...\n" + str.slice(-half);
}

async function scorePairFast(resume, jd) {
  // Keep the payload tiny, and fail fast within ~8s to fit Netlify free limits
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), 8000);

  const system = 'Return ONLY JSON: { "match_score": number }. Score 0-100 based on exact phrase overlap between resume and JD. Short output.';
  const user = JSON.stringify({ resume: trimMiddle(resume, 6000), jd: trimMiddle(jd, 4000) });
  try {
    const j = await openAI({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0,
      top_p: 1,
      response_format: { type: 'json_object' },
      max_tokens: 30
    }, controller.signal);
    clearTimeout(timeout);
    const v = Number(j?.match_score);
    if (Number.isFinite(v)) return Math.max(0, Math.min(100, v));
    throw new Error('bad json');
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// Original (slower) scorer used elsewhere
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
  const v = Number(data?.match_score);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
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
    'Distribute JD terms naturally across the resume:',
    '- PROFESSIONAL SUMMARY: high-level scope, domains, leadership.',
    '- EXPERIENCE BULLETS: tools, frameworks, metrics, outcomes; integrate JD phrases directly into bullet text.',
    '- SKILLS & TOOLS MATCH: only remaining high-impact terms not already used elsewhere; hard cap 10 unique items.',
    'Never dump a long keyword list. Prefer weaving terms once or twice where they read naturally.',
    'Keep employers and dates intact; edit wording for clarity and impact.',
    gaps.length ? `Prioritize weaving these truthful JD terms across summary/experience; put leftovers in Skills (max 10): ${gaps.join(', ')}.`
                : 'Use only what is reasonably inferable from the original; do not invent experience.',
    'Return ONLY JSON: { "rewritten_resume": string }.',
    'Style: concise, metric-forward bullets; avoid fluff; no duplicate keywords.'
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
    max_tokens: 1100
  });
  return String(data?.rewritten_resume || '').trim();
}

function sanitizeResume(text = '') {
  try {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(l => /skills\s*&\s*tools\s*match/i.test(l));
    if (start === -1) return text;
    let i = start + 1;
    const buf = [];
    while (i < lines.length && !/^[A-Z][A-Z \-]{3,}$/.test(lines[i]) && lines[i].trim() !== '') {
      buf.push(lines[i].trim());
      i++;
    }
    const raw = buf.join(' ');
    const items = Array.from(new Set(
      raw
        .replace(/^[\-\*\u2022]\s*/gm,'')
        .split(/[•\-\*]|,|·|\n/)
        .map(s => s.trim())
        .filter(Boolean)
    ));
    const limited = items.slice(0, 10);
    const formatted = limited.map(it => `- ${it}`).join('\n');
    const newLines = lines.slice(0, start + 1).concat([formatted, '']).concat(lines.slice(i));
    return newLines.join('\n');
  } catch {
    return text;
  }
}

// very fast, crude similarity as a fallback
function localSimilarity(resume, jd) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 2);
  const r = new Set(norm(resume));
  const j = new Set(norm(jd));
  let inter = 0;
  for (const w of j) if (r.has(w)) inter++;
  const score = j.size ? Math.round((inter / j.size) * 100) : 0;
  return Math.max(0, Math.min(100, score));
}

async function openAI(payload, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal || controller.signal
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
