// js/llm.js — runs fully in-browser (safe for GitHub Pages)
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// Force ONNX Runtime to safe single-thread WASM (disable SIMD)
env.backends.onnx.wasm = {
  wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/',
  simd: false,       // explicitly disable SIMD
  numThreads: 1,
  proxy: false
};

// Always fetch models remotely, cache locally
env.allowLocalModels = false;
env.useBrowserCache = true;


// ✅ correct ONNX Runtime WASM files (needed for browser inference)
env.backends.onnx.wasm.wasmPaths =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';

// don’t look for local /models; always fetch from Hugging Face
env.allowLocalModels = false;
// cache model files in the browser for faster reloads
env.useBrowserCache = true;

let embedder = null;   // semantic similarity (Analyze)
let generator = null;  // rewriting + JD extraction (Rewrite)

export async function initModels() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
}

async function ensureGenerator() {
  if (!generator) {
    // use a browser-friendly text2text model (not text-generation)
    generator = await pipeline('text2text-generation', 'Xenova/LaMini-Flan-T5-248M');
  }
}

export async function embedTexts(texts) {
  await initModels();
  const out = await embedder(texts, { normalize: true, pooling: 'mean' });
  return Array.isArray(out.data[0]) ? out.data : [out.data];
}

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
    // fallback: naive keyword split if model returns non-JSON
    const lines = jd.split(/\n|\.|;|,/).map(s => s.trim()).filter(Boolean);
    const kw = lines
      .filter(s => /required|must|need|proficient|experience|with|in/i.test(s))
      .slice(0, 16);
    parsed.must_have = kw.slice(0, 8);
    parsed.nice = kw.slice(8, 16);
  }

  const clean = t => String(t || '').toLowerCase().replace(/^[\-•\s]+/, '').trim();
  parsed.must_have = [...new Set((parsed.must_have || []).map(clean).filter(Boolean))];
  parsed.nice      = [...new Set((parsed.nice      || []).map(clean).filter(Boolean))];

  return parsed;
}

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

  // targeted suggestions for gaps
  const suggPrompt = `Create 5 concise bullet suggestions to cover these gaps:
${JSON.stringify(scoring.missing.must.concat(scoring.missing.nice).slice(0, 6))}
Each bullet must be truthful and include outcomes if available; otherwise add [VERIFY].
Output as a simple list (one per line).`;

  const s = await generator(suggPrompt, { max_new_tokens: 180, temperature: 0.3 });
  const raw = (s[0]?.generated_text || '').trim();
  const suggestions = raw
    .split(/\n+/)
    .map(x => x.replace(/^[-•\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 6);

  return { rewritten, suggestions };
}
