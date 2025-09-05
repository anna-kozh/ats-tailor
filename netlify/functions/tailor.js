// netlify/functions/tailor.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const FETCH_TIMEOUT_MS = 25000; // 25s global guard

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
      const out = await openAI(
        buildMsgAnalyze(trimMiddle(resume, 6000), trimMiddle(jd, 4000)),
        { max_tokens: 30, temperature: 0, fastMs: 6000 }
      );
      const score = clamp(Number(out?.match_score), 0, 100, 0);
      return json({ match_score: score });
    } catch (e) {
      // fallback to local similarity to avoid 502
      const score = localSimilarity(resume, jd);
      return json({ match_score: score, fallback: true });
    }
  }

  if (action === 'rewrite') {
    const { resume = '', jd = '' } = body || {};
    if (!resume || !jd) return json({ error: 'Missing resume or jd' }, 400);
    const out = await openAI(
      buildMsgRewrite(trimMiddle(resume, 7000), trimMiddle(jd, 5000)),
      { max_tokens: 1100, temperature: 0.35 }
    );
    const rewritten = sanitizeResume(String(out?.rewritten_resume || resume));
    const score = clamp(Number(out?.estimated_score), 0, 100, 0);
    const missing = Array.isArray(out?.missing_keywords) ? out.missing_keywords.slice(0,24) : [];
    return json({ rewritten_resume: rewritten, final_score: score, missing_keywords: missing });
  }

  if (action === 'approve') {
    const { resume_v2 = '', jd = '', approved_keywords = [] } = body || {};
    if (!resume_v2 || !jd) return json({ error: 'Missing resume_v2 or jd' }, 400);
    const out = await openAI(
      buildMsgApprove(trimMiddle(resume_v2, 7000), trimMiddle(jd, 5000), approved_keywords),
      { max_tokens: 1200, temperature: 0.3 }
    );
    const final_resume = sanitizeResume(String(out?.final_resume || resume_v2));
    const final_score = clamp(Number(out?.final_score), 0, 100, 0);
    const missing_after = Array.isArray(out?.missing_keywords_after) ? out.missing_keywords_after.slice(0,20) : [];
    return json({ final_resume, final_score, missing_keywords_after: missing_after });
  }

  return json({ error: 'Unknown action' }, 400);
}

/** ---------- Prompt builders (single-call per action) ---------- */
function buildMsgAnalyze(resume, jd) {
  const system = 'Return ONLY JSON: { "match_score": number }. Score 0–100 strictly by exact phrase overlap and clear semantic match between resume and JD. Short output.';
  return {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ resume, jd }) }
    ],
    response_format: { type: 'json_object' }
  };
}

function buildMsgRewrite(resume, jd) {
  const system = [
    'You are an expert ATS resume tailor. Return ONLY JSON:',
    '{ "rewritten_resume": string, "estimated_score": number, "missing_keywords": string[] }.',
    'Distribute JD terms naturally across the resume:',
    '- PROFESSIONAL SUMMARY: high-level domains & scope; leadership signals.',
    '- EXPERIENCE: integrate JD tools/frameworks/metrics into bullets (no stuffing).',
    '- SKILLS & TOOLS MATCH: only leftover high-impact terms, max 10; no duplicates.',
    'Keep employers/dates; concise, metric-forward; no fabrication.'
  ].join(' ');
  return {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ resume, jd }) }
    ],
    temperature: 0.35,
    response_format: { type: 'json_object' }
  };
}

function buildMsgApprove(resume_v2, jd, approved_keywords) {
  const approved = Array.isArray(approved_keywords) ? approved_keywords.join(', ') : '';
  const system = [
    'You are an expert ATS resume tailor. One-pass optimize and return ONLY JSON:',
    '{ "final_resume": string, "final_score": number, "missing_keywords_after": string[] }.',
    'Goal: reach truthful match ≥95 when possible in a single pass.',
    'Weave APPROVED terms when truthful: ' + approved + '.',
    'Distribute JD terms naturally (summary, experience bullets, skills<=10).',
    'No keyword dumping. Keep employers/dates. Concise, metric-forward bullets.'
  ].join(' ');
  return {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ resume_v2, jd }) }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  };
}

/** ---------- Utils ---------- */
function trimMiddle(str, maxChars = 8000) {
  if (!str) return '';
  if (str.length <= maxChars) return str;
  const half = Math.floor(maxChars / 2);
  return str.slice(0, half) + "\n...\n" + str.slice(-half);
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
      raw.replace(/^[\-\*\u2022]\s*/gm,'')
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

// fast local fallback
function localSimilarity(resume, jd) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 2);
  const r = new Set(norm(resume));
  const j = new Set(norm(jd));
  let inter = 0;
  for (const w of j) if (r.has(w)) inter++;
  const score = j.size ? Math.round((inter / j.size) * 100) : 0;
  return Math.max(0, Math.min(100, score));
}

// OpenAI wrapper with optional fast timeout for Analyze
async function openAI(msgPayload, { max_tokens=256, temperature=0, fastMs=null } = {}) {
  const controller = new AbortController();
  const t1 = setTimeout(() => controller.abort(new Error('timeout')), fastMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...msgPayload, max_tokens, temperature }),
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
    clearTimeout(t1);
  }
}

function json(body, status=200){
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function readJson(req){ try { return JSON.parse(await req.text()); } catch { return {}; } }
function clamp(n, min, max, fb=0){ const v = Number(n); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb; }
