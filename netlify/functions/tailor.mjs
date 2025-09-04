// netlify/functions/tailor.mjs  — Netlify Functions v2 (Web API)
export default async function handler(request, context) {
  try {
    if (request.method === 'GET') {
      return json({ ok: true, msg: 'tailor up' }, 200);
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method Not Allowed' }, 405);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ error: 'Missing OPENAI_API_KEY env var' }, 500);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { action, resume, jd, mode = 'conservative' } = payload;
    if (!resume || !jd) return json({ error: 'resume and jd are required' }, 400);
    if (action !== 'analyze' && action !== 'rewrite') {
      return json({ error: 'unknown action' }, 400);
    }

    const system = `You are a senior hiring manager and resume editor.
Return STRICT JSON:
{
  "match_score": number,
  "capped_reason": string|null,
  "missing_required": string[],
  "missing_nice": string[],
  "bullet_suggestions": string[],
  "rewritten_resume": string
}
Rules: cap score at 85 if any explicit must-have is missing; do not invent facts; use [VERIFY] if numbers are unknown.
Style: concise, results-first. Mode=${mode}.`;

    const user = JSON.stringify({ mode, job_description: jd, resume });

    const out = await callOpenAI(apiKey, system, user);
    const parsed = safeJSON(out);

    if (action === 'analyze') {
      return json({
        match_score: parsed.match_score ?? 0,
        capped_reason: parsed.capped_reason ?? null,
        missing_required: parsed.missing_required ?? [],
        missing_nice: parsed.missing_nice ?? [],
        bullet_suggestions: parsed.bullet_suggestions ?? [],
        flags: parsed.flags ?? []
      }, 200);
    }

    // rewrite
    return json(parsed, 200);
  } catch (err) {
    return json({ error: 'Function crash', detail: String(err?.message || err) }, 502);
  }
}

async function callOpenAI(apiKey, system, user) {
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || '{}';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
function safeJSON(s) { try { return JSON.parse(s); } catch { return { error: 'non-json', raw: s }; } }
