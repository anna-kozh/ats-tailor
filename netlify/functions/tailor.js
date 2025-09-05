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

    const system = [
      'You are an expert ATS resume tailor. Return ONLY JSON with keys:',
      '{ "final_resume": string, "final_score": number, "missing_keywords_after": string[] }.',
      'Goal: reach a truthful ATS match ≥95 when possible in ONE pass.',
      'Distribute JD terms naturally: summary for high-level scope; experience bullets for tools/metrics; skills block for leftovers (max 10).',
      'Weave these approved JD terms when truthful: ' + (Array.isArray(approved_keywords) ? approved_keywords.join(', ') : '') + '.',
      'Keep employers/dates; concise, metric-forward bullets; no keyword stuffing or duplication.'
    ].join(' ');
    const user = JSON.stringify({ resume_v2, jd });

    const out = await openAI({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.3,
      top_p: 1,
      response_format: { type: 'json_object' },
      max_tokens: 1200
    });

    const final_resume = sanitizeResume(String(out?.final_resume || resume_v2));
    const final_score = Number(out?.final_score) || 0;
    const missing_keywords_after = Array.isArray(out?.missing_keywords_after) ? out.missing_keywords_after.slice(0,20) : [];

    return json({ final_resume, final_score, missing_keywords_after });
  }

  return json({ error: 'Unknown action' }, 400);
}
