// Netlify Function: rewrite (Modern ATS-style scoring + OpenAI rewrite)
// One fast pass per click to avoid 504 timeouts. Click again to iterate.
// Env: OPENAI_API_KEY

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 8000; // keep calls snappy

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    const { resumeV1, jd } = JSON.parse(event.body || "{}");
    if (!resumeV1 || !jd) return json(400, { error: "Missing resumeV1 or jd" });
    if (!OPENAI_API_KEY) return json(500, { error: "Missing OPENAI_API_KEY env var" });

    // 1) Mine JD → weighted terms (1–3-grams, TF-IDF-ish + section hints)
    const jdTerms = mineJDTerms(jd);

    // 2) Score v1 deterministically (Coverage 70 + Placement 15 + Context 15 − Penalties ≤10)
    const s1 = scoreResume(resumeV1, jdTerms);

    // 3) Plan keywords to lift to 95 (deterministic greedy marginal-gain)
    const plan = planTo95(jdTerms, s1, 95);

    // 4) One OpenAI rewrite pass per request (to avoid 504s). It will weave the plan.
    let resumeV2 = resumeV1;
    let s2 = s1;
    if (s1.total < 95 && plan.items.length) {
      resumeV2 = await openaiRewrite({
        resumeV1: truncate(resumeV1, 3000),
        jd: truncate(jd, 3000),
        plan: plan.items
      });
      if (!resumeV2 || resumeV2.trim().length < 50) resumeV2 = resumeV1; // safety
      s2 = scoreResume(resumeV2, jdTerms);
    }

    return json(200, {
      scoreV1: s1.total,
      resumeV2,
      scoreV2: s2.total,
      details: {
        jdTerms,
        plan: plan.items,
        projectedAfterPlan: plan.projected,
        v1_breakdown: s1.breakdown,
        v2_breakdown: s2.breakdown,
        nextAction: s2.total >= 95 ? "done" : "rewrite_again"
      }
    });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

/* =========================
   Keyword mining (JD → terms)
   ========================= */

const STOPWORDS = new Set(`
a an the and or but of in on at for with from by as is are was were be been being to your you we they it this that these those over under during into after before about across our their us them i me my mine ours yours his her its if then than so such etc via per
about-based using through within will ability strong excellent great good new plus etc etc.
`.trim().split(/\s+/));

const SYNONYMS = {
  "design system": ["design systems","component library","component libraries","ui kit","ui system"],
  "design tokens": ["tokens","color tokens","typography tokens"],
  "user research": ["ux research","customer interviews","user interviews","discovery research"],
  "usability testing": ["user testing","ux testing","usability studies","research sessions"],
  "accessibility": ["a11y","wcag"],
  "prototyping": ["prototype","prototypes","rapid prototyping","hi-fi prototype","low-fi prototype"],
  "interaction design": ["ixd","interaction","flows","user flows"],
  "visual design": ["ui design","interface design"],
  "a/b testing": ["experimentation","ab testing","split testing"],
  "metrics": ["kpis","north star metric","analytics"],
  "llm": ["large language model","foundation model","foundational model"],
  "rag": ["retrieval augmented generation","retrieval-augmented generation"],
  "prompt engineering": ["prompt design","prompting","prompt craft"],
  "agent": ["agentic","autonomous agent","copilot","assistant","ai agent","agentic ux"],
  "react": ["react.js","reactjs"],
  "node.js": ["node","nodejs"],
  "typescript": ["ts"],
  "javascript": ["js"],
  "next.js": ["next","nextjs"],
  "hipaa": ["phi","health privacy"],
  "soc 2": ["soc2"]
};

const CANON_KEYS = Object.keys(SYNONYMS);

const JD_TITLE_HINTS = [/^role\b/i, /^title\b/i];
const JD_REQ_HINTS = /(must|required|minimum|qualifications|requirements)/i;
const JD_RESP_HINTS = /(responsibilities|what you'll do|you will|about the role|role)/i;
const JD_NICE_HINTS = /(nice to have|preferred|bonus)/i;

function mineJDTerms(jdRaw) {
  const lines = jdRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let weightMap = new Map();

  const titleLine = lines[0] || "";
  const sections = lines.map((line, idx) => {
    const text = line.toLowerCase();
    if (idx === 0 || JD_TITLE_HINTS.some(rx => rx.test(line))) return { text: line, base: 3 };
    if (JD_REQ_HINTS.test(line)) return { text: line, base: 3 };
    if (JD_RESP_HINTS.test(line)) return { text: line, base: 2 };
    if (JD_NICE_HINTS.test(line)) return { text: line, base: 1 };
    // Default neutral content
    return { text: line, base: 2 };
  });

  for (const { text, base } of sections) {
    const toks = tokenize(text);
    const grams = ngrams(toks, 3); // 1–3 grams
    const local = new Map();
    for (const g of grams) {
      if (!isValidGram(g)) continue;
      const canon = canonical(g);
      local.set(canon, (local.get(canon) || 0) + 1);
    }
    for (const [term, freq] of local) {
      // Section weighted freq with log-dampening
      const add = base * (1 + Math.log(1 + freq));
      weightMap.set(term, (weightMap.get(term) || 0) + add);
    }
  }

  // Boost title terms (common in real JD ranking)
  for (const t of ngrams(tokenize(titleLine), 3)) {
    if (!isValidGram(t)) continue;
    const can = canonical(t);
    weightMap.set(can, (weightMap.get(can) || 0) + 1.5);
  }

  // Convert to array, filter noise, keep top 40
  let arr = Array.from(weightMap.entries())
    .filter(([term, w]) => term.length >= 2 && w > 1.2) // drop very weak/noisy terms
    .map(([term, w]) => ({ term, weight: w }));

  // Normalize to weights {3,2,1} banded by quantiles
  arr.sort((a,b)=>b.weight - a.weight);
  const topN = Math.min(40, arr.length);
  arr = arr.slice(0, topN);
  const ws = arr.map(x=>x.weight);
  const q66 = quantile(ws, 0.66);
  const q33 = quantile(ws, 0.33);
  for (const x of arr) {
    x.weight = x.weight >= q66 ? 3 : (x.weight >= q33 ? 2 : 1);
  }
  // Dedup near-duplicates (e.g., "design system" vs "design systems")
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = x.term;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  // Sort final: weight desc, then alpha
  out.sort((a,b)=>b.weight - a.weight || a.term.localeCompare(b.term));
  return out;
}

/* =========================
   Deterministic scoring
   ========================= */

const ACTION_VERBS = ["Led","Designed","Implemented","Optimized","Launched","Improved","Partnered","Migrated","Refactored","Streamlined","Built","Owned","Drove","Shipped"];
const METRIC_RE = /\b(\d+(\.\d+)?\s?%|\$\d+(?:\.\d+)?|[0-9]+(?:k|m)?\s?(users|requests|sessions|teams|clients|leads|revenue|ms|s))\b/i;
const PLACEHOLDER_METRIC_RE = /\[(metric|impact|result)s?\]/i;

function scoreResume(resumeRaw, jdTerms) {
  const resume = resumeRaw || "";
  const norm = resume.toLowerCase();
  const sections = splitResumeSections(resume);
  const totalWords = resume.split(/\s+/).filter(Boolean).length;

  // Coverage 70
  const W = jdTerms.reduce((s,k)=>s + mapWeight70(k.weight), 0) || 1;
  let M = 0;
  const perTermScore = {};
  for (const t of jdTerms) {
    const ms = matchScore(norm, t.term);
    perTermScore[t.term] = ms;
    M += mapWeight70(t.weight) * ms;
  }
  let coverage = 70 * (M / W);
  if (totalWords > 1200) coverage = Math.max(0, coverage - 2);

  // Placement 15 (distinct terms per section)
  const dSummary = distinctHits(sections.summary, jdTerms).size;
  const dRoles   = distinctHits(sections.roles,   jdTerms).size;
  const dSkills  = distinctHits(sections.skills,  jdTerms).size;

  const pSummary = 5 * Math.min(1, dSummary / 3);
  const pRoles   = 7 * Math.min(1, dRoles   / 10);
  const pSkills  = 3 * Math.min(1, dSkills  / 10);

  let placement = pSummary + pRoles + pSkills;
  const totalDistinct = Math.max(1, dSummary + dRoles + dSkills);
  if (dSkills >= 0.6 * totalDistinct) placement = Math.min(placement, 7);

  // Context 15 (Experience sentences with verbs + metrics)
  let contextPts = 0;
  for (const s of splitSentences(sections.roles)) {
    const sLower = s.toLowerCase();
    const hasKW = jdTerms.some(t => phraseIn(sLower, t.term));
    if (!hasKW) continue;
    const hasVerb = ACTION_VERBS.some(v => new RegExp(`\\b${escapeRe(v.toLowerCase())}\\b`).test(sLower));
    if (hasVerb) contextPts += 1;
    if (hasVerb && (METRIC_RE.test(s) || PLACEHOLDER_METRIC_RE.test(s))) contextPts += 1;
    if (contextPts >= 15) break;
  }
  const context = Math.min(15, contextPts);

  // Penalties ≤10
  let penalty = 0;
  for (const t of jdTerms) {
    const re = new RegExp(`\\b${escapeRe(t.term)}\\b`, "gi");
    const count = (resume.match(re)||[]).length;
    if (count > 3) penalty += 1;
  }
  penalty = Math.min(10, penalty);

  const total = clamp0_100(round1(coverage + placement + context - penalty));
  const missing = jdTerms
    .map(t => ({...t, ms: perTermScore[t.term] ?? 0}))
    .filter(x => x.ms < 1.0) // not exact yet
    .sort((a,b)=> (b.weight - a.weight) || (a.ms - b.ms) || a.term.localeCompare(b.term));

  return {
    total,
    breakdown: { coverage: round1(coverage), placement: round1(placement), context: round1(context), penalty },
    perTermScore,
    sectionDistinct: { summary: dSummary, roles: dRoles, skills: dSkills },
    contextPts,
    missing
  };
}

function mapWeight70(w){ return w === 3 ? 3 : w === 2 ? 2 : 1; } // simple linear mapping to keep relative weights
function distinctHits(sectionText, jdTerms) {
  const out = new Set();
  const s = (sectionText || "").toLowerCase();
  for (const t of jdTerms) if (phraseIn(s, t.term)) out.add(t.term);
  return out;
}

function matchScore(resumeLower, term) {
  // Exact n-gram
  if (phraseIn(resumeLower, term)) return 1.0;
  // Synonym ~ full credit
  for (const canon of CANON_KEYS) {
    if (term === canon) {
      const syns = SYNONYMS[canon];
      if (syns.some(s => phraseIn(resumeLower, s))) return 0.85;
    }
  }
  // Head word stem approx
  const head = headWord(term);
  const stemRe = new RegExp(`\\b${escapeRe(head)}(s|es|ing|ed)?\\b`, "i");
  if (stemRe.test(resumeLower)) return 0.6;
  return 0;
}

/* =========================
   Greedy plan to reach 95
   ========================= */

function planTo95(jdTerms, scored, target = 95) {
  // Current state
  let projected = scored.total;
  let counts = { ...scored.sectionDistinct }; // {summary, roles, skills}
  let contextPts = scored.contextPts;
  const W = jdTerms.reduce((s,k)=>s + mapWeight70(k.weight), 0) || 1;

  const missing = jdTerms
    .map(t => ({...t, ms: scored.perTermScore[t.term] ?? 0}))
    .filter(x => x.ms < 1.0);

  const items = [];
  const maxAdds = 16;

  // Helper to recompute placement after adding one distinct term to a section
  const placementScore = (c) => {
    let pS = 5 * Math.min(1, c.summary / 3);
    let pR = 7 * Math.min(1, c.roles   / 10);
    let pK = 3 * Math.min(1, c.skills  / 10);
    let p   = pS + pR + pK;
    const totalDistinct = Math.max(1, c.summary + c.roles + c.skills);
    if (c.skills >= 0.6 * totalDistinct) p = Math.min(p, 7);
    return p;
  };
  const basePlacement = placementScore(counts);

  // Greedy select
  for (const m of missing) {
    if (items.length >= maxAdds || projected >= target) break;

    // Coverage delta if we make it exact once
    const covDelta = 70 * ((mapWeight70(m.weight) * (1.0 - m.ms)) / W);

    // Try each target section and pick best marginal gain
    const choices = ["roles","summary","skills"];
    let best = { section: "roles", gain: -1, placementDelta: 0, contextDelta: 0 };

    for (const sec of choices) {
      const nextCounts = { ...counts };
      const distinctAlready = distinctHitsForSection(sec, m.term, scored); // whether term already counted in that section
      if (!distinctAlready) nextCounts[sec] = nextCounts[sec] + 1;

      const newPlacement = placementScore(nextCounts);
      const placementDelta = newPlacement - basePlacement;

      // Context: only grows if we add to roles and we still have headroom
      const contextDelta = sec === "roles" ? Math.min(2, Math.max(0, 15 - contextPts)) : 0;

      const totalGain = covDelta + placementDelta + contextDelta;
      if (totalGain > best.gain) best = { section: sec, gain: totalGain, placementDelta, contextDelta };
    }

    // Apply the best choice
    items.push({ term: m.term, weight: m.weight, target: best.section, covDelta: round1(covDelta), placeDelta: round1(best.placementDelta), ctxDelta: best.contextDelta });
    // Update projected state
    if (best.section === "roles") contextPts = Math.min(15, contextPts + best.contextDelta);
    const sectionAlready = distinctHitsForSection(best.section, m.term, scored);
    if (!sectionAlready) counts[best.section] += 1;
    projected = round1(projected + covDelta + best.placementDelta + best.contextDelta);
  }

  return { items, projected };
}

function distinctHitsForSection(section, term, scored) {
  const secText = section === "summary" ? "summary" : section === "roles" ? "roles" : "skills";
  // We don't have per-term per-section mapping from score, so approximate:
  // If the resume already had the exact term anywhere in that section, it would have contributed;
  // use a coarse heuristic: if total distinct in that section >= total distinct overall perTerm? Not available.
  // Simpler: assume not counted per section; planner will overestimate placement occasionally, acceptable.
  // Return false so we add +1 distinct per planned insertion.
  return false;
}

/* =========================
   OpenAI rewrite (single pass)
   ========================= */

async function openaiRewrite({ resumeV1, jd, plan }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const content = [
`ROLE / JD (truncated):
${jd}

KEYWORDS TO WEAVE (target section):
${plan.map(p => `- ${p.term} → ${p.target}`).join("\n")}

INSTRUCTIONS:
- Rewrite the resume so these keywords appear naturally and meaningfully.
- Place terms per target section:
  • Summary: 1–2 tight lines using 2–4 top-weight terms.
  • Experience (roles): add or edit bullets; each bullet uses an action verb and includes a concrete metric or a [metric] placeholder.
  • Skills: add remaining terms to a flat list; no duplicates, no stacking variants (e.g., "React" vs "React.js" → pick one).
- Keep facts plausible. Do NOT invent employers, dates, or degrees. Do NOT change job titles wildly.
- Senior, crisp tone. Avoid keyword dumping. Keep total under ~900 words.
- Output ONLY the rewritten resume text (no markdown, no commentary).

RESUME V1:
${resumeV1}`
  ].join("\n");

  const body = {
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: "You are a precise resume rewriter that follows instructions exactly." },
      { role: "user", content }
    ]
  };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${txt}`);
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || "").trim();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") return ""; // let caller handle retry via second click
    throw err;
  }
}

/* =========================
   Resume section helpers
   ========================= */

function splitResumeSections(raw) {
  const lower = (raw || "").toLowerCase();
  const idxSkills = lower.search(/(?:^|\n)\s*(skills?|tooling|technologies)\s*[:\n]/);
  const idxExp    = lower.search(/(?:^|\n)\s*(experience|work experience|employment|roles|career)\s*[:\n]/);
  const idxSummary= lower.search(/(?:^|\n)\s*(summary|objective|profile|about)\s*[:\n]/);
  let summary = "", roles = "", skills = "";

  if (idxSummary >= 0) {
    const end = idxExp >= 0 ? idxExp : (idxSkills >= 0 ? idxSkills : raw.length);
    summary = raw.slice(idxSummary, end).replace(/^(summary|objective|profile|about)\s*[:\n]*/i,"").trim();
  }
  if (idxExp >= 0) {
    const end = idxSkills >= 0 ? idxSkills : raw.length;
    roles = raw.slice(idxExp, end).replace(/^(experience|work experience|employment|roles|career)\s*[:\n]*/i,"").trim();
  } else {
    const end = idxSkills >= 0 ? idxSkills : raw.length;
    roles = raw.slice(0, end).trim();
  }
  if (idxSkills >= 0) {
    skills = raw.slice(idxSkills).replace(/^(skills?|tooling|technologies)\s*[:\n]*/i,"").trim();
  }
  return { summary, roles, skills };
}

/* =========================
   Text utils
   ========================= */

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\+\#\.\- ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t));
}

function ngrams(tokens, maxN=3) {
  const out = [];
  for (let i=0;i<tokens.length;i++){
    for (let n=1;n<=maxN;n++){
      if (i+n>tokens.length) break;
      const gram = tokens.slice(i,i+n).join(" ");
      out.push(gram);
    }
  }
  return out;
}

function isValidGram(g) {
  if (!g) return false;
  if (g.length < 2) return false;
  // discard pure numbers and single letters
  if (/^[0-9]+$/.test(g)) return false;
  if (/^[a-z]$/.test(g)) return false;
  // avoid common junk grams
  if (STOPWORDS.has(g)) return false;
  return true;
}

function canonical(term) {
  term = term.toLowerCase();
  for (const canon of CANON_KEYS) {
    if (term === canon) return canon;
    if ((SYNONYMS[canon] || []).includes(term)) return canon;
  }
  return term;
}

function headWord(term) {
  return (term.split(/\s+/)[0] || "").toLowerCase();
}

function phraseIn(textLower, phrase) {
  return new RegExp(`\\b${escapeRe(phrase.toLowerCase())}\\b`).test(textLower);
}

function splitSentences(s) {
  return (s || "")
    .split(/\n+|(?<=\.)\s+(?=[A-Z])/g)
    .map(t => t.trim())
    .filter(Boolean);
}

/* =========================
   Generic helpers
   ========================= */

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function round1(n){ return Math.round(n*10)/10; }
function clamp0_100(n){ return Math.max(0, Math.min(100, n)); }
function quantile(arr, q){
  if (!arr.length) return 0;
  const a = [...arr].sort((x,y)=>x-y);
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (a[base+1] !== undefined) return a[base] + rest * (a[base+1] - a[base]);
  return a[base];
}
function truncate(s, max){ s = String(s||""); return s.length > max ? s.slice(0, max) : s; }
