// Netlify Function: rewrite (OpenAI rewrite + deterministic ATS scoring)
// Fast path: one rewrite per request to avoid Netlify 504 timeouts.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_PASSES = 1;        // was 3
const OPENAI_TIMEOUT_MS = 8000; // hard cap per rewrite

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    const { resumeV1, jd } = JSON.parse(event.body || "{}");
    if (!resumeV1 || !jd) return json(400, { error: "Missing resumeV1 or jd" });
    if (!OPENAI_API_KEY) return json(500, { error: "Missing OPENAI_API_KEY env var" });

    const sim = new ATSSim();
    const jdKeywords = sim.extractKeywords(jd);

    // Score v1
    const s1 = sim.scoreResume(resumeV1, jdKeywords);

    // One quick rewrite pass to stay under Netlify timeouts
    let current = resumeV1;
    let sCurr = s1;
    let passes = 0;

    if (sCurr.total < 95) {
      const missing = sCurr.missing.map(m => m.term);
      const rewritten = await openaiRewrite(
        truncate(resumeV1, 2500),
        truncate(jd, 2500),
        missing
      );
      if (rewritten && rewritten.trim().length > 50) {
        current = rewritten.trim();
        sCurr = sim.scoreResume(current, jdKeywords);
        passes = 1;
      }
    }

    return json(200, {
      scoreV1: s1.total,
      resumeV2: current,
      scoreV2: sCurr.total,
      details: {
        jdKeywords,
        scoreV1_breakdown: s1.breakdown,
        scoreV2_breakdown: sCurr.breakdown,
        missing_after_v2: sCurr.missing,
        passes
      },
      // If still <95, click Rewrite again (keeps requests fast, no 504s).
      nextAction: sCurr.total >= 95 ? "done" : "rewrite_again"
    });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

// ---------------- OpenAI call with timeout ----------------
async function openaiRewrite(resumeV1, jd, missingTerms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const body = {
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You are a precise resume rewriter. Goal: weave the JD's missing keywords naturally across Summary (1–2 lines), Roles (bullets with actions + impacts), and Skills (flat list). Keep facts plausible. Do not fabricate employers or degrees. Maintain senior tone. Avoid keyword dumping. Keep under ~900 words. Output ONLY the rewritten resume text, no markdown, no commentary."
      },
      {
        role: "user",
        content:
`JOB DESCRIPTION:
${jd}

MISSING KEYWORDS TO ADD (high priority first):
${(missingTerms || []).slice(0, 20).join(", ") || "None"}

RESUME V1 (rewrite this into V2 with the missing terms woven across sections):
${resumeV1}`
      }
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
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${txt}`);
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || "").trim();
  } catch (err) {
    clearTimeout(t);
    // If timeout/abort, return empty so UI can prompt a second click
    if (err.name === "AbortError") return "";
    throw err;
  }
}

function truncate(s, max) { s = String(s || ""); return s.length > max ? s.slice(0, max) : s; }

// ---------------- Utils ----------------
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function splitSentences(s) {
  return (s || "").split(/\n+|(?<=\.)\s+(?=[A-Z])/g).map(t => t.trim()).filter(Boolean);
}
function uniq(arr) { return Array.from(new Set(arr)); }
function round1(n) { return Math.round(n * 10) / 10; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// ---------------- Lexicons ----------------
const SKILL_LEXICON = [
  "design system","design systems","design tokens","component library","figma","figjam",
  "user research","usability testing","accessibility","wcag","information architecture",
  "prototyping","interaction design","visual design","journey mapping",
  "a/b testing","experimentation","metrics","data-informed","product strategy",
  "llm","large language model","prompt engineering","rag","agent","genai","ai ux","agentic ux",
  "react","next.js","typescript","javascript","tailwind","node.js",
  "jira","confluence","amplitude","mixpanel","segment",
  "hipaa","phi","soc 2","hl7","fhir"
];

const SYNONYMS = {
  "design system": ["design systems","component library","component libraries","ui system","ui kit"],
  "design tokens": ["tokens","color tokens","typography tokens"],
  "user research": ["ux research","customer interviews","user interviews","discovery research"],
  "usability testing": ["user testing","ux testing","usability studies","research sessions"],
  "accessibility": ["a11y","wcag"],
  "prototyping": ["prototype","prototypes","rapid prototyping","hi-fi prototype","low-fi prototype"],
  "interaction design": ["ixd","interaction","flows","user flows"],
  "visual design": ["ui design","interface design"],
  "a/b testing": ["experimentation","ab testing","split testing"],
  "metrics": ["kpis","north star metric","analytics"],
  "llm": ["large language model","foundation model"],
  "rag": ["retrieval augmented generation","retrieval-augmented generation"],
  "prompt engineering": ["prompt design","prompting"],
  "agent": ["agentic","autonomous agent","copilot","assistant"],
  "ai ux": ["genai ux","ai product design","ai experience"],
  "react": ["react.js","reactjs"],
  "node.js": ["node","nodejs"],
  "typescript": ["ts"],
  "javascript": ["js"],
  "next.js": ["nextjs","next"],
  "hipaa": ["phi","health privacy"],
  "soc 2": ["soc2"]
};

const ACTION_VERBS = ["Led","Designed","Implemented","Optimized","Launched","Improved","Partnered","Migrated","Refactored","Streamlined"];

// ---------------- ATS Simulator ----------------
class ATSSim {
  extractKeywords(jdRaw) {
    const jd = jdRaw.toLowerCase();
    const buckets = { required: new Set(), core: new Set(), nice: new Set() };
    const reqCtx = /(must|required|need(ed)?|minimum|required qualifications)/;
    const niceCtx = /(nice to have|bonus|preferred)/;
    const coreCtx = /(responsibilities|what you'll do|you will|about the role|role|what we need)/;

    for (const phrase of SKILL_LEXICON) {
      if (jd.includes(phrase)) {
        let bucket = "core";
        const idx = jd.indexOf(phrase);
        const start = Math.max(0, idx - 140);
        const end = Math.min(jd.length, idx + phrase.length + 140);
        const window = jd.slice(start, end);

        if (reqCtx.test(window)) bucket = "required";
        else if (niceCtx.test(window)) bucket = "nice";
        else if (coreCtx.test(window)) bucket = "core";

        buckets[bucket].add(phrase);
      }
    }

    const list = [];
    for (const k of buckets.required) list.push({ term: k, weight: 3 });
    for (const k of buckets.core) list.push({ term: k, weight: 2 });
    for (const k of buckets.nice) list.push({ term: k, weight: 1 });

    if (list.length < 6) {
      const titleLine = (jdRaw.split("\n")[0] || "").toLowerCase();
      for (const t of ["design system","figma","user research","accessibility","prototyping","a/b testing","react","llm","agent"]) {
        if (titleLine.includes("design") || jd.includes(t)) {
          if (!list.find(x => x.term === t)) list.push({ term: t, weight: 2 });
        }
      }
    }

    const seen = new Set();
    const out = [];
    for (const item of list) {
      const canon = this.canonical(item.term);
      const key = canon + ":" + item.weight;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ term: canon, weight: item.weight });
      }
    }
    return out.sort((a,b)=>b.weight-a.weight || a.term.localeCompare(b.term));
  }

  canonical(term) {
    term = term.toLowerCase();
    for (const [canon, syns] of Object.entries(SYNONYMS)) {
      if (term === canon || syns.includes(term)) return canon;
    }
    return term;
  }

  matchScore(resumeRaw, keyword) {
    const resume = resumeRaw.toLowerCase();
    if (resume.includes(keyword)) return 1.0;
    const syns = SYNONYMS[keyword] || [];
    for (const s of syns) if (resume.includes(s)) return 0.7;
    const head = keyword.split(/\s+/)[0];
    const headRe = new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|ing|ed)?\\b`);
    if (headRe.test(resume)) return 0.5;
    return 0;
  }

  splitSections(resumeRaw) {
    const raw = resumeRaw;
    const lower = raw.toLowerCase();
    const findIdx = (r) => lower.search(r);

    const idxSkills = findIdx(/(?:^|\n)\s*(skills?|tooling|technologies)\s*[:\n]/);
    const idxExp = findIdx(/(?:^|\n)\s*(experience|work experience|employment|roles|career)\s*[:\n]/);
    const idxSummary = findIdx(/(?:^|\n)\s*(summary|objective|profile|about)\s*[:\n]/);

    let summary = "", roles = "", skills = "";
    if (idxSummary >= 0) {
      const end = idxExp >= 0 ? idxExp : (idxSkills >= 0 ? idxSkills : raw.length);
      summary = raw.slice(idxSummary, end).replace(/^(summary|objective|profile|about)\s*[:\n]*/i, "").trim();
    }
    if (idxExp >= 0) {
      const end = idxSkills >= 0 ? idxSkills : raw.length;
      roles = raw.slice(idxExp, end).replace(/^(experience|work experience|employment|roles|career)\s*[:\n]*/i, "").trim();
    } else {
      const end = idxSkills >= 0 ? idxSkills : raw.length;
      roles = raw.slice(0, end).trim();
    }
    if (idxSkills >= 0) {
      skills = raw.slice(idxSkills).replace(/^(skills?|tooling|technologies)\s*[:\n]*/i, "").trim();
    }
    return { summary, roles, skills };
  }

  scoreResume(resumeRaw, jdKeywords) {
    const totalWords = resumeRaw.split(/\s+/).filter(Boolean).length;
    const { summary, roles, skills } = this.splitSections(resumeRaw);

    const W = jdKeywords.reduce((s, k) => s + k.weight, 0) || 1;
    let M = 0;
    const perTerm = {};
    for (const k of jdKeywords) {
      const ms = this.matchScore(resumeRaw, k.term);
      perTerm[k.term] = ms;
      M += k.weight * ms;
    }
    let coverage = 80 * (M / W);
    if (totalWords > 1200) coverage = Math.max(0, coverage - 2);

    function distinctHits(section) {
      const sec = section.toLowerCase();
      const set = new Set();
      for (const k of jdKeywords) {
        if (sec.includes(k.term) || (SYNONYMS[k.term] || []).some(s => sec.includes(s))) set.add(k.term);
      }
      return set.size;
    }
    const needSummary = 3, needRoles = 8, needSkills = 8;
    const dSummary = Math.min(1, distinctHits(summary) / needSummary);
    const dRoles = Math.min(1, distinctHits(roles) / needRoles);
    const dSkills = Math.min(1, distinctHits(skills) / needSkills);
    let distribution = 10 * (0.25 * dSummary + 0.5 * dRoles + 0.25 * dSkills);

    const totalDistinct = distinctHits(summary) + distinctHits(roles) + distinctHits(skills) || 1;
    const onlySkills = distinctHits(skills) >= (0.6 * totalDistinct);
    if (onlySkills) distribution = Math.min(distribution, 6);

    const verbs = ACTION_VERBS.map(v => v.toLowerCase());
    let contextPoints = 0;
    const sentences = splitSentences(roles);
    for (const s of sentences) {
      const sLower = s.toLowerCase();
      const hasKW = jdKeywords.some(k => sLower.includes(k.term) || (SYNONYMS[k.term] || []).some(x => sLower.includes(x)));
      if (!hasKW) continue;
      const hasVerb = verbs.some(v => new RegExp(`\\b${v.toLowerCase()}\\b`).test(sLower));
      if (hasVerb) contextPoints += 1;
      const hasMetric = /\b\d+(\.\d+)?\s?(%|k|m|ms|s|users|requests|teams|clients|revenue|leads)\b/.test(sLower) || /\[(metric|impact|result)s?\]/.test(sLower);
      if (hasVerb && hasMetric) contextPoints += 1;
      if (contextPoints >= 10) break;
    }
    const context = Math.min(10, contextPoints);

    let penalty = 0;
    for (const k of jdKeywords) {
      const re = new RegExp(`\\b${escapeRe(k.term)}\\b`, "gi");
      const count = (resumeRaw.match(re) || []).length;
      if (count > 3) penalty += 1;
    }
    penalty = Math.min(10, penalty);

    const total = Math.max(0, Math.min(100, round1(coverage + distribution + context - penalty)));
    const missing = jdKeywords.filter(k => perTerm[k.term] < 1).sort((a, b) => b.weight - a.weight);

    return {
      total,
      breakdown: { coverage: round1(coverage), distribution: round1(distribution), context: round1(context), penalty },
      missing
    };
  }
}
