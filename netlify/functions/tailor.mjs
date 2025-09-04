// netlify/functions/tailor.mjs
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

// Keep calls comfortably below Netlify time limits (cold start + exec)
const FETCH_TIMEOUT_MS = 8500;
const MAX_TOKENS_REWRITE = 1400;

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!OPENAI_API_KEY) return json({ error: "Missing OPENAI_API_KEY" }, 500);

  const body = await readJson(req);
  const { action } = body || {};
  if (!action) return json({ error: "Missing action" }, 400);

  if (action === "analyze") {
    const { resume = "", jd = "" } = body || {};
    if (!resume || !jd) return json({ error: "Missing resume or jd" }, 400);
    const score = await scorePair(resume, jd);
    return json({ match_score: score });
  }

  // Do exactly one rewrite+score pass per request (client will loop).
  if (action === "rewrite_pass") {
    const { resume = "", jd = "" } = body || {};
    if (!resume || !jd) return json({ error: "Missing resume or jd" }, 400);

    const gaps = await findGaps(resume, jd);
    const rewritten = await rewritePass(resume, jd, gaps);
    const score = await scorePair(rewritten || resume, jd);

    return json({
      rewritten_resume: String(rewritten || resume),
      match_score: Number(score) || 0,
      used_gaps: gaps
    });
  }

  return json({ error: "Unknown action" }, 400);
}

/** --- Helpers --- **/

/** Score 0–100 */
async function scorePair(resume, jd) {
  const system = [
    "You are an ATS evaluator. Return JSON only: { \"match_score\": number }.",
    "0-100 scale; reward explicit JD must-haves and exact phrases; no hallucination."
  ].join(" ");
  const user = JSON.stringify({ resume, jd });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0,
    top_p: 1,
    response_format: { type: "json_object" }
  });

  return clamp(Number(data?.match_score), 0, 100, 0);
}

/** Extract JD terms the resume is weak/missing on */
async function findGaps(resume, jd) {
  const system = [
    "Extract ATS-relevant keywords/phrases present in the JD but absent or weak in the resume.",
    "Return JSON only: { \"missing_keywords\": string[] }.",
    "Max 30 items. Focus on concrete skills, tools, domains, certifications, exact phrases."
  ].join(" ");
  const user = JSON.stringify({ resume, jd });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0,
    top_p: 1,
    response_format: { type: "json_object" }
  });

  const arr = Array.isArray(data?.missing_keywords) ? data.missing_keywords : [];
  return arr.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
}

/** One rewrite pass guided by gaps (no fabrication) */
async function rewritePass(resume, jd, gaps = []) {
  const system = [
    "Expert resume tailor for ATS. Rewrite to strongly align without fabrication.",
    "Keep concise, measurable impact, prioritize JD must-haves and exact phrases.",
    gaps.length
      ? `Weave in these JD terms only if plausible from the original wording: ${gaps.join(", ")}.`
      : "Use only information that could reasonably be inferred from the original wording.",
    "Return JSON only: { \"rewritten_resume\": string }."
  ].join(" ");

  const user = JSON.stringify({ resume, jd });

  const data = await openAI({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.4,
    top_p: 1,
    response_format: { type: "json_object" },
    max_tokens: MAX_TOKENS_REWRITE
  });

  return String(data?.rewritten_resume || "").trim();
}

/** OpenAI wrapper with hard timeout */
async function openAI(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${t}`);
    }
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content?.trim() || "{}";
    try { return JSON.parse(content); } catch { return {}; }
  } finally {
    clearTimeout(timer);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function readJson(req) { try { return JSON.parse(await req.text()); } catch { return {}; } }
function clamp(n, min, max, fb = 0) { const v = Number(n); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb; }
