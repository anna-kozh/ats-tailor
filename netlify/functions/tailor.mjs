// Netlify serverless function (Node-style return object)
export default async function handler(event, context) {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return j({ error: 'Missing OPENAI_API_KEY env var' }, 500);
    }

    const { action, resume, jd, mode = 'conservative' } =
      JSON.parse(event.body || '{}');

    if (!resume || !jd) return j({ error: 'resume and jd are required' }, 400);

    const system = `You are a senior hiring manager and resume editor.
Return STRICT JSON with:
{
 "match_score": number,
 "capped_reason": string|null,
 "missing_required": string[],
 "missing_nice": string[],
 "bullet_suggestions": string[],
 "rewritten_resume": string
}
Rules: cap score at 85 if any explicit must-have missing; do not invent facts; use [VERIFY] if numbers are unknown. Mode=${mode}.`;

    const user = JSON.stringify({ mode, job_description: jd, resume });

    const out = await openaiChat(apiKey, system, user);
    const parsed = safeParse(out);

    if (action === 'analyze') {
      // omit rewritten body on analyze
      const resp = {
        match_score: parsed.match_score ?? 0,
        capped_reason: parsed.capped_reason ?? null,
        missing_required: parsed.missing_required ?? [],
        missing_nice: parsed.missing_nice ?? [],
        bullet_suggestions: parsed.bullet_suggestions ?? [],
        flags: parsed.flags ?? []
      };
      return j(resp, 200);
    }

    if (action === 'rewrite') {
      return j(parsed, 200);
    }

    return j({ error: 'unknown action' }, 400);
  } catch (err) {
    return j({ error: 'Unhandled error', detail: String(err) }, 500);
  }
}

async function openaiChat(apiKey, system, user) {
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
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || '{}';
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return { error: 'non-json', raw: s }; }
}
function j(obj, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(obj)
  };
}
