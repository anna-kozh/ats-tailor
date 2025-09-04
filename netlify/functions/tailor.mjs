// netlify/functions/tailor.mjs
// Node 18+ on Netlify. ES modules enabled via .mjs.
// Uses OpenAI Chat Completions with JSON format for stable parsing.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return json({ error: 'Use POST' }, 405);
    }

    const body = await readJson(req);
    const { action } = body || {};

    if (!OPENAI_API_KEY) {
      return json({ error: 'Missing OPENAI_API_KEY' }, 500);
    }

    if (action === 'analyze') {
      const { resume = '', jd = '' } = body || {};
      if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);

      const result = await analyzeResume(resume, jd);
      return json(result);
    }

    if (action === 'rewrite') {
      const { resume = '', jd = '', mode = 'conservative' } = body || {};
      if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);

      const result = await rewriteResume(resume, jd, mode);

      // If model ever fails to produce a rewritten string, fall back to original to avoid frontend break
      if (!result.rewritten_resume || result.rewritten_resume.trim().length === 0) {
        result.rewritten_resume = resume;
      }

      return json(result);
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: 'Server error', details: err.message || String(err) }, 500);
  }
};

/* ---------------- helpers ---------------- */

async function analyzeResume(resume, jd) {
  const sys = [
    'You are an ATS evaluator.',
    'Score how well the resume matches the job description (0 to 100).',
    'Identify missing must-have skills vs nice-to-have skills.',
    'Suggest 5 to 10 concise bullet improvements.',
    'Output JSON only with keys:',
    '{ "match_score": number, "missing_required": string[], "missing_nice": string[], "bullet_suggestions": string[], "flags": string[], "capped_reason": string|null }',
    'Be strict but fair. Never invent experience.'
  ].join(' ');

  const user = JSON.stringify({ resume, jd });

  const data = await openAIJson({
    model: MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  // safe defaults if model omits fields
  return {
    match_score: clampNumber(data.match_score, 0, 100, 0),
    missing_required: arr(data.missing_required),
    missing_nice: arr(data.missing_nice),
    bullet_suggestions: arr(data.bullet_suggestions),
    flags: arr(data.flags),
    capped_reason: data.capped_reason ?? null
  };
}

async function rewriteResume(resume, jd, mode) {
  const intensity = mode === 'aggressive'
    ? 'Aggressive: restructure sections, add quantified impact, reorder bullets, and insert role-relevant keywords that are truthful given the resume and JD. Remove weak bullets.'
    : 'Conservative: keep structure, rewrite bullets for clarity, add quantifiable outcomes, insert missing but truthful keywords. Keep voice and seniority.';

  const sys = [
    'You are an expert resume tailor focused on ATS optimization.',
    'Goal: rewrite the resume so it scores higher against the JD.',
    'Follow rules strictly:',
    '1) Do NOT fabricate experience, titles, or employers.',
    '2) You MAY rephrase existing content and emphasize provable outcomes.',
    '3) You MAY add standard responsibilities only if they are reasonably implied by the resume AND align with the JD.',
    '4) Prefer measurable impact (numbers, %, time saved, cost reduced).',
    '5) Use keywords from the JD naturally.',
    '6) Keep a senior, concise tone.',
    'Output JSON only with keys:',
    '{ "rewritten_resume": string, "suggestions": string[] }'
  ].join(' ');

  const user = JSON.stringify({
    mode,
    guidance: intensity,
    resume,
    jd
  });

  const data = await openAIJson({
    model: MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    temperature: mode === 'aggressive' ? 0.6 : 0.4,
    response_format: { type: 'json_object' },
    max_tokens: 2000
  });

  return {
    rewritten_resume: typeof data.rewritten_resume === 'string' ? data.rewritten_resume : '',
    suggestions: arr(data.suggestions)
  };
}

async function openAIJson(payload) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content?.trim() || '{}';
  // content is JSON because we set response_format: json_object
  try {
    return JSON.parse(content);
  } catch {
    // If the model returns non-JSON for any reason, try to salvage
    return safeExtractJson(content);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function readJson(req) {
  const text = await req.text();
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function arr(x) { return Array.isArray(x) ? x : []; }
function clampNumber(n, min, max, fallback = 0) {
  const v = Number(n);
  if (Number.isFinite(v)) return Math.min(max, Math.max(min, v));
  return fallback;
}

// Very lenient JSON salvage if the model ever slips non-JSON wrappers.
function safeExtractJson(s) {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return {};
}
