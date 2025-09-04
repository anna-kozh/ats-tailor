// js/llm.js — runs fully in-browser with Transformers.js (no keys, no server)
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// Force remote model downloads (avoid 404s from local /models path)
env.allowLocalModels = false;
// (Optional) cache in browser storage for faster reloads
env.useBrowserCache = true;

// Optional ONNX runtime path (stable CDN)
env.backends.onnx.wasm.wasmPaths =
  'https://cdn.jsdelivr.net/npm/@xenova/onnxruntime-web@1.18.0/dist/';

let embedder = null;          // for semantic similarity
let generator = null;         // for rewriting + extracting JD

export async function initModels() {
  // Load embeddings model only (fast) for Analyze step
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
}

// Load a SMALL, supported text2text model for browser use
async function ensureGenerator() {
  if (!generator) {
    // LaMini-Flan-T5 is well supported for text2text-generation in the browser
    generator = await pipeline('text2text-generation', 'Xenova/LaMini-Flan-T5-248M');
  }
}

// Convenience: embed multiple strings (returns array of vectors)
export async function embedTexts(texts) {
  await initModels();
  const out = await embedder(texts, { normalize: true, pooling: 'mean' });
  return Array.isArray(out.data[0]) ? out.data : [out.data];
}

// Extract must-haves and nice-to-haves from JD into strict JSON
export async function extractJD(jd) {
  await ensureGenerator();

  const prompt = `Extract hiring requirements from the JD.
Return STRICT JSON ONLY with keys "must_have" and "nice" (arrays of short phrases).
Only mark "must_have" if JD uses words like "required", "must", "need".
No prose.

JD:
${jd}`;

  const res = await generator(prompt, {
    max_new_tokens: 220,
    temperature: 0.2,
    repetition_penalty: 1.1,
  });

  let text = (res[0]?.generated_text || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  let parsed = { must_have: [], nice: [] };

  try {
    parsed = JSON.parse(m ? m[0] : text);
  } catch {
    // Fallback: naive keyword split
    const lines = jd.split(/\n|\.|;|,/).map(s => s.trim()).filter(Boolean);
    const kw = lines.filter(s => /required|must|need|proficient|experience|with|in/i.test(s)).slice(0, 16);
    parsed.must_have = kw.slice(0, 8);
    parsed.nice = kw.slice(8, 16);
  }

  const clean = t => String(t || '').toLowerCase().replace(/^[\-•\s]+/, '').trim();
  parsed.must_have = [...new Set((parsed.must_have || []).map(clean).filter(Boolean))];
  parsed.nice = [...new Set((parsed.nice || []).map(clean).filter(Boolean))];
  return parsed;
}

// Create a tailored rewrite and bullet suggestions (truthful; add [VERIFY] if numbers unknown)
export async function generateRewrite(resume, jd, jdInfo, scoring, mode = 'conservative') {
  await ensureGenerator();

  const sys = `Rewrite the resume to align with the JD without fabricating facts.
Use action verbs. Keep employers/titles/dates intact.
If a number is unknown, add [VERIFY]. Output plain text only.`;

  const guidance = `Must-haves: ${JSON.stringify(jdInfo.must_have)}
Missing: ${JSON.stringify(scoring.missing.must)}
Nice: ${JSON.stringify(jdInfo.nice)}
Evidence score: ${scoring.evidence.points}/20
Mode: ${mode}`;

  const prompt = `${sys}

JOB DESCRIPTION:
${jd}

CURRENT RESUME:
${resume}

GUIDANCE:
${guidance}

Now output the rewritten resume text only:`;

  const out = await generator(prompt, {
    max_new_tokens: 900,
    temperature: mode === 'aggressive' ? 0.7 : 0.25,
    repetition_penalty: 1.1,
  });
  const rewritten = (out[0]?.generated_text || '').trim();

  // Suggestions targeted at missing items
  const suggPrompt = `Create 5 concise bullet suggestions to cover these gaps:
${JSON.stringify(scoring.missing.must.concat(scoring.missing.nice).slice(0, 6))}
Each bullet must be truthful and include outcomes if available; otherwise add [VERIFY].
Output as a simple list (no numbering, one per line).`;

  const s = await generator(suggPrompt, { max_new_tokens: 180, temperature: 0.3 });
  const raw = (s[0]?.generated_text || '').trim();
  const suggestions = raw.split(/\n+/).map(x => x.replace(/^[-•\s]+/, '').trim()).filter(Boolean).slice(0, 6);

  return { rewritten, suggestions };
}
