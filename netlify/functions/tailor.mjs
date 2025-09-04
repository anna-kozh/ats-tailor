// netlify/functions/tailor.mjs
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json({ error: 'Missing OPENAI_API_KEY environment variable' }, 500);
    }

    const { action, resume, jd, mode = 'conservative' } = await req.json();
    if (!resume || !jd) return json({ error: 'resume and jd are required' }, 400);

    const system = `You are a senior hiring manager and resume editor.
Compare the candidate resume to the job description and respond in STRICT JSON using this schema:
{
  "match_score": number,                // 0–100
  "capped_reason": string | null,       // why the score is capped (if any)
  "missing_required": string[],         // hard must-haves not evidenced
  "missing_nice": string[],             // good-to-have items missing
  "bullet_suggestions": string[],       // concise, results-oriented bullets
  "rewritten_resume": string            // edited resume in plaintext; mark uncertain numbers with [VERIFY]
}
Scoring rubric:
- Must-have coverage (weight 3x). If any explicit must-have missing → cap at 85.
- Evidence strength: +2 per bullet with numbers/scope/outcomes; vague claims −2.
- Semantic alignment: verbs/tools/domains over title matching.
Guardrails:
- Do NOT invent employers, titles, dates, or metrics. If unknown, use [VERIFY].
- Style: clear, concise, US English.
Rewrite mode: If mode="conservative", keep structure & wording similar. If "aggressive", restructure for impact.`;

    const user = JSON.stringify({ mode, job_description: jd, resume });

    // Analyze
    if (action === 'analyze') {
      const out = await openaiChat(apiKey, system, user);
      const parsed = safeParse(out);
      // drop rewritten text on analyze; keep suggestions for UI
      return json({
        match_score: parsed.match_score ?? 0,
        capped_reason: parsed.capped_reason ?? null,
        missing_required: parsed.missing_required ?? [],
        missing_nice: parsed.missing_nice ?? [],
        bullet_suggestions: parsed.bullet_suggestions ?? [],
        flags: parsed.flags ?? []
      }, 200);
    }

    // Rewrite
    if (action === 'rewrite') {
      const out = await openaiChat(apiKey, system, user);
      const parsed = safeParse(out);
      return json(parsed, 200);
    }

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    return json({ error: 'Unhandled error', detail: String(err) }, 500);
  }
}

async function openaiChat(apiKey, system, user){
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "{}";
}

function safeParse(s){
  try { return JSON.parse(s); } catch { return { error: "non-json", raw: s }; }
}

function json(obj, status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control":"no-store" }
  });
}
