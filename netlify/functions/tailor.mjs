// netlify/functions/tailor.mjs — iterative rewrite to maximize ATS score (truthfully)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

// Targets/toggles
const TARGET_SCORE = 95;         // aim for >=95 if possible without fabrication
const MAX_IMPROVE_PASSES = 2;    // number of refine loops after first rewrite

export default async function handler(req) {
  try {
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
      const { resume = '', jd = '', mode = 'conservative' } = body || {};
      if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);

      // baseline analysis
      const baseline = await analyzeResume(resume, jd);

      // first rewrite using gaps
      let { rewritten_resume, suggestions } = await rewriteResume(resume, jd, mode, baseline);
      if (!rewritten_resume || !rewritten_resume.trim()) rewritten_resume = resume;

      // analyze rewritten
      let current = await analyzeResume(rewritten_resume, jd);

      // refine loop up to MAX_IMPROVE_PASSES
      let passes = 0;
      while (current.match_score < TARGET_SCORE && passes < MAX_IMPROVE_PASSES) {
        const improved = await improveResume({
          original: resume,
          current: rewritten_resume,
          jd,
          mode,
          currentScore: current.match_score,
          missing_required: current.missing_required,
          missing_nice: current.missing_nice
        });
        if (improved && improved.trim() && improved !== rewritten_resume) {
          rewritten_resume = improved;
          current = await analyzeResume(rewritten_resume, jd);
          passes++;
        } else {
          break; // model couldn’t improve without fabricating
        }
      }

      return json({
        rewritten_resume,
        suggestions,
        final_score: current.match_score,
        final_missing_required: current.missing_required,
        final_missing_nice: current.missing_nice,
        passes
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: 'Server error', details: err?.message || String(err) }, 500);
  }
}

/* ---------------- analyzers & rewriters ---------------- */

async function analyzeResume(resume, jd) {
  // Scoring rubric skews toward JD term coverage + responsibility alignment; no fabrication
  const system = [
    'You are an ATS evaluator.',
    'Score 0–100 how well the resume matches the job description.',
    'Rubric:',
    '• 70%: presence of JD keywords/skills phrased naturally (avoid keyword stuffing).',
    '• 20%: alignment of responsibilities/scope and seniority.',
    '• 10%: outcomes/metrics.',
    'Never credit skills clearly absent. If critical must-haves are missing, explain via capped_reason.',
    'Output JSON only: { "match_score": number, "missing_required": string[], "missing_nice": string[], "bullet_suggestions": string[], "flags": string[], "capped_reason": string|null }'
  ].join(' ');

  const user = JSON.stringify({ resume, jd });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  return {
    match_score: clamp(data.match_score, 0, 100, 0),
    missing_required: arr(data.missing_required),
    missing_nice: arr(data.missing_nice),
    bullet_suggestions: arr(data.bullet_suggestions),
    flags: arr(data.flags),
    capped_reason: data.capped_reason ?? null
  };
}

async function rewriteResume(resume, jd, mode, baseline) {
  const intensity = mode === 'aggressive'
    ? 'Aggressive: restructure sections, compress fluff, front-load JD keywords, quantify results, and remove weak bullets.'
    : 'Conservative: keep structure, tighten language, add metrics, and naturally weave JD keywords.';

  const system = [
    'You are an expert resume tailor focused on maximizing ATS match without fabricating.',
    'Rules:',
    '1) Do NOT invent employers, titles, or projects.',
    '2) You MAY rephrase to emphasize measurable outcomes.',
    '3) You MAY add a Skills section and reorder content.',
    '4) Include JD-relevant keywords ONLY if plausibly supported by the original resume.',
    'Output JSON: { "rewritten_resume": string, "suggestions": string[] }.'
  ].join(' ');

  const user = JSON.stringify({
    mode,
    intensity,
    jd,
    baseline_gaps: {
      missing_required: baseline.missing_required,
      missing_nice: baseline.missing_nice
    },
    instructions: [
      'Address baseline gaps when truthful.',
      'Prefer bullets that include action + impact + metric.',
      'Keep concise, senior tone.'
    ],
    resume
  });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: mode === 'aggressive' ? 0.6 : 0.4,
    response_format: { type: 'json_object' },
    max_tokens: 2000
  });

  return {
    rewritten_resume: str(data.rewritten_resume),
    suggestions: arr(data.suggestions)
  };
}

async function improveResume({ original, current, jd, mode, currentScore, missing_required, missing_nice }) {
  const system = [
    'You are refining a resume to raise ATS score further WITHOUT fabricating.',
    'Prefer minimal edits with maximum keyword/role alignment and metrics.',
    'If required skills are missing and not in the original, do NOT add them.'
  ].join(' ');

  const user = JSON.stringify({
    currentScore,
    missing_required,
    missing_nice,
    jd_terms_hint: 'Cover JD terminology naturally (no stuffing). Add/adjust Skills & Tools section if truthful.',
    mode,
    original_resume: original,
    current_resume: current,
    jd
  });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' }
  });

  return str(data.rewritten_resume) || '';
}

/* ---------------- low-level helpers ---------------- */

async function openAI(payload) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => '')}`);

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content?.trim() || '{}';
  try { return JSON.parse(content); } catch { return salvageJson(content); }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function readJson(req) { const t = await req.text(); try { return JSON.parse(t || '{}'); } catch { return {}; } }
function arr(x) { return Array.isArray(x) ? x : []; }
function str(s) { return typeof s === 'string' ? s : ''; }
function clamp(n, min, max, fb = 0) { const v = Number(n); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb; }
function salvageJson(s) { const a = s.indexOf('{'); const b = s.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} } return {}; }
