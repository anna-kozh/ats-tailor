// Netlify Function: rewrite (deterministic ATS simulator + rewrite-to-95)
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Use POST" });
    }
    const { resumeV1, jd } = JSON.parse(event.body || "{}");
    if (!resumeV1 || !jd) return json(400, { error: "Missing resumeV1 or jd" });

    const sim = new ATSSim();
    const jdKeywords = sim.extractKeywords(jd);
    const s1 = sim.scoreResume(resumeV1, jdKeywords);
    let v2 = rewriteTo95(resumeV1, jd, jdKeywords, sim);
    const s2 = sim.scoreResume(v2, jdKeywords);

    const details = {
      jdKeywords,
      scoreV1_breakdown: s1.breakdown,
      scoreV2_breakdown: s2.breakdown,
      missing_after_v2: s2.missing,
    };

    return json(200, {
      scoreV1: s1.total,
      resumeV2: v2,
      scoreV2: s2.total,
      details
    });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

// ---------------- Utils ----------------
function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}
function normalize(s) {
  return (s || "")
    .replace(/\r/g, " ")
    .replace(/[^\w\s\-\+\.\%/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function splitSentences(s) {
  return (s || "")
    .split(/\n+|(?<=\.)\s+(?=[A-Z])/g)
    .map(t => t.trim())
    .filter(Boolean);
}
function uniq(arr){ return Array.from(new Set(arr)); }

// ---------------- Lexicons ----------------
const STOPWORDS = new Set(`a an the and or but of in on at for with to from by as is are was were be been being your you we they it this that these those over under during into after before about across our their us them i me my mine ours yours his her its if then than so such etc via per`.split(/\s+/));

// Canonical skill phrases (expand as needed)
const SKILL_LEXICON = [
  // Design core
  "design system","design systems","design tokens","component library","figma","figjam",
  "user research","usability testing","accessibility","wcag","information architecture",
  "prototyping","interaction design","visual design","journey mapping",
  "a/b testing","experimentation","metrics","data-informed","product strategy",
  // AI/agents
  "llm","large language model","prompt engineering","rag","agent","genai","ai ux","agentic ux",
  // Frontend ecosystem (for JD matching context)
  "react","next.js","typescript","javascript","tailwind","node.js",
  // Platforms/process
  "jira","confluence","amplitude","mixpanel","segment",
  // Reg/healthcare
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
  "soc 2": ["soc2"],
};

// Action verbs used to craft role bullets deterministically
const ACTION_VERBS = ["Led","Designed","Implemented","Optimized","Launched","Improved","Partnered","Migrated","Refactored","Streamlined"];

// ---------------- ATS Simulator ----------------
class ATSSim {
  // Extract weighted JD keywords using lexicon + synonyms + simple section heuristics
  extractKeywords(jdRaw){
    const jd = jdRaw.toLowerCase();
    const buckets = { required: new Set(), core: new Set(), nice: new Set() };
    // Heuristics by section markers
    const reqCtx = /(must|required|need(ed)?|minimum|required qualifications)/;
    const niceCtx = /(nice to have|bonus|preferred)/;
    const coreCtx = /(responsibilities|what you'll do|you will|about the role|role|what we need)/;

    for (const phrase of SKILL_LEXICON) {
      if (jd.includes(phrase)) {
        // Decide bucket based on nearest markers
        let bucket = "core";
        // Window around the phrase
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

    // Build keyword list with weights
    const list = [];
    for (const k of buckets.required) list.push({ term: k, weight: 3 });
    for (const k of buckets.core) list.push({ term: k, weight: 2 });
    for (const k of buckets.nice) list.push({ term: k, weight: 1 });

    // If JD is sparse, fallback: pick top title words as core
    if (list.length < 6) {
      const titleLine = (jdRaw.split("\n")[0] || "").toLowerCase();
      for (const t of ["design system","figma","user research","accessibility","prototyping","a/b testing","react","llm","agent"]) {
        if (titleLine.includes("design") || jd.includes(t)) {
          if (!list.find(x => x.term === t)) list.push({ term: t, weight: 2 });
        }
      }
    }

    // Normalize: remove duplicates by canonical
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

  // Canonicalize using synonyms table
  canonical(term){
    term = term.toLowerCase();
    for (const [canon, syns] of Object.entries(SYNONYMS)) {
      if (term === canon || syns.includes(term)) return canon;
    }
    return term;
  }

  // Check if resume has a match for a keyword
  matchScore(resumeRaw, keyword){
    const resume = resumeRaw.toLowerCase();
    // exact phrase
    if (resume.includes(keyword)) return 1.0;
    // synonyms hit → 0.7
    const syns = SYNONYMS[keyword] || [];
    for (const s of syns) if (resume.includes(s)) return 0.7;
    // head word lemmatized (simple stem)
    const head = keyword.split(/\s+/)[0];
    const headRe = new RegExp(`\\b${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|ing|ed)?\\b`);
    if (headRe.test(resume)) return 0.5;
    return 0;
  }

  // Split resume into sections (summary, roles, skills)
  splitSections(resumeRaw){
    const raw = resumeRaw;
    const lower = raw.toLowerCase();
    const findIdx = (r) => lower.search(r);

    const idxSkills = findIdx(/(?:^|\n)\s*(skills?|tooling|technologies)\s*[:\n]/);
    const idxExp = findIdx(/(?:^|\n)\s*(experience|work experience|employment|roles|career)\s*[:\n]/);
    const idxSummary = findIdx(/(?:^|\n)\s*(summary|objective|profile|about)\s*[:\n]/);

    let summary = "", roles = "", skills = "";
    if (idxSummary >= 0) {
      const end = idxExp >= 0 ? idxExp : (idxSkills >= 0 ? idxSkills : raw.length);
      summary = raw.slice(idxSummary, end).replace(/^(summary|objective|profile|about)\s*[:\n]*/i,"").trim();
    }
    if (idxExp >= 0) {
      const end = idxSkills >= 0 ? idxSkills : raw.length;
      roles = raw.slice(idxExp, end).replace(/^(experience|work experience|employment|roles|career)\s*[:\n]*/i,"").trim();
    } else {
      // If no explicit Experience header, treat everything except skills as roles
      const end = idxSkills >= 0 ? idxSkills : raw.length;
      roles = raw.slice(0, end).trim();
    }
    if (idxSkills >= 0) {
      skills = raw.slice(idxSkills).replace(/^(skills?|tooling|technologies)\s*[:\n]*/i,"").trim();
    }
    return { summary, roles, skills };
  }

  // Compute coverage, distribution, context, penalties
  scoreResume(resumeRaw, jdKeywords){
    const totalWords = resumeRaw.split(/\s+/).filter(Boolean).length;
    const { summary, roles, skills } = this.splitSections(resumeRaw);
    const textLower = resumeRaw.toLowerCase();

    // Coverage
    const W = jdKeywords.reduce((s,k)=>s+k.weight, 0) || 1;
    let M = 0;
    const perTerm = {};
    for (const k of jdKeywords) {
      const ms = this.matchScore(resumeRaw, k.term);
      perTerm[k.term] = ms;
      M += k.weight * ms;
    }
    let coverage = 80 * (M / W);
    if (totalWords > 1200) coverage = Math.max(0, coverage - 2);

    // Distribution
    function distinctHits(section){
      const sec = section.toLowerCase();
      const set = new Set();
      for (const k of jdKeywords) {
        if (sec.includes(k.term) || (SYNONYMS[k.term]||[]).some(s=>sec.includes(s))) set.add(k.term);
      }
      return set.size;
    }
    const needSummary = 3, needRoles = 8, needSkills = 8;
    const dSummary = Math.min(1, distinctHits(summary)/needSummary);
    const dRoles = Math.min(1, distinctHits(roles)/needRoles);
    const dSkills = Math.min(1, distinctHits(skills)/needSkills);
    let distribution = 10 * (0.25*dSummary + 0.5*dRoles + 0.25*dSkills);
    // Anti-dumping
    const totalDistinct = distinctHits(summary) + distinctHits(roles) + distinctHits(skills) || 1;
    const onlySkills = distinctHits(skills) >= (0.6 * totalDistinct);
    if (onlySkills) distribution = Math.min(distribution, 6);

    // Context
    const verbs = ACTION_VERBS.map(v=>v.toLowerCase());
    let contextPoints = 0;
    const sentences = splitSentences(roles);
    for (const s of sentences) {
      const sLower = s.toLowerCase();
      const hasKW = jdKeywords.some(k => sLower.includes(k.term) || (SYNONYMS[k.term]||[]).some(x=>sLower.includes(x)));
      if (!hasKW) continue;
      const hasVerb = verbs.some(v => new RegExp(`\\b${v.toLowerCase()}\\b`).test(sLower));
      if (hasVerb) contextPoints += 1;
      // metric OR placeholder counts (+1)
      const hasMetric = /\b\d+(\.\d+)?\s?(%|k|m|ms|s|users|requests|teams|clients|revenue|leads)\b/.test(sLower) || /\[(metric|impact|result)s?\]/.test(sLower);
      if (hasVerb && hasMetric) contextPoints += 1;
      if (contextPoints >= 10) break;
    }
    const context = Math.min(10, contextPoints);

    // Penalties
    let penalty = 0;
    // Stuffing >3 per term
    for (const k of jdKeywords) {
      const re = new RegExp(`\\b${escapeRe(k.term)}\\b`, "gi");
      const count = (resumeRaw.match(re)||[]).length;
      if (count > 3) penalty += 1;
    }
    penalty = Math.min(10, penalty);

    const total = Math.max(0, Math.min(100, round1(coverage + distribution + context - penalty)));

    // Missing list (by low match score)
    const missing = jdKeywords.filter(k => perTerm[k.term] < 1).sort((a,b)=>b.weight-a.weight);

    return {
      total,
      breakdown: { coverage: round1(coverage), distribution: round1(distribution), context: round1(context), penalty },
      missing
    };
  }
}

function round1(n){ return Math.round(n*10)/10; }
function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------- Rewrite Loop ----------------
function rewriteTo95(resumeV1, jd, jdKeywords, sim){
  let current = resumeV1;
  for (let pass = 0; pass < 3; pass++){
    const score = sim.scoreResume(current, jdKeywords);
    if (score.total >= 95) return current;
    const missing = score.missing.slice(0, 12); // keep it sane

    // Split sections
    const sections = sim.splitSections(current);
    let { summary, roles, skills } = sections;

    // 1) Summary: add 2-4 highest weight missing terms
    const addSummary = uniq(missing.filter(k=>k.weight>=2).map(k=>k.term)).slice(0,4);
    if (addSummary.length){
      if (!summary) summary = "";
      const line = `Focused on ${toOxford(addSummary)}.`;
      summary = ensurePrefixedHeader("Summary", summary);
      summary = mergeSummary(summary, line);
    }

    // 2) Roles: weave bullets with action verbs + placeholders
    const toWeave = missing.slice(0, 8).map(m=>m.term);
    if (toWeave.length){
      roles = ensurePrefixedHeader("Experience", roles || "");
      const bullets = toWeave.map((term, i) => {
        const verb = ACTION_VERBS[i % ACTION_VERBS.length];
        return `• ${verb} initiatives in ${term} to improve outcomes [metric].`;
      }).join("\n");
      roles = roles.trim() + "\n" + bullets + "\n";
    }

    // 3) Skills: add remaining distinct terms
    const skillsList = extractSkillList(skills);
    const existing = new Set(skillsList.map(x=>x.toLowerCase()));
    const toAdd = uniq(missing.map(m=>m.term).filter(t=>!existing.has(t.toLowerCase())));
    const newSkills = uniq(skillsList.concat(toAdd)).slice(0, 60);
    skills = ensurePrefixedHeader("Skills", newSkills.join(", "));

    // Join sections back
    current = joinSections({ summary, roles, skills });
  }
  return current;
}

function ensurePrefixedHeader(header, content){
  content = (content || "").trim();
  if (!content.toLowerCase().startsWith(header.toLowerCase())) {
    return `${header}\n${content}`.trim();
  }
  return content;
}
function mergeSummary(summaryBlock, line){
  const parts = summaryBlock.split("\n").map(s=>s.trim()).filter(Boolean);
  if (parts.length <= 1) return `${parts[0]}\n${line}`.trim();
  // Append as last sentence to first paragraph
  const head = parts[0].replace(/\.*$/, "");
  parts[0] = `${head}. ${line}`;
  return parts.join("\n");
}
function extractSkillList(skillsBlock){
  const s = (skillsBlock || "").replace(/^(skills?|tooling|technologies)\s*[:\n]*/i,"");
  // split on commas or newlines
  const arr = s.split(/,|\n|•/).map(x=>x.trim()).filter(Boolean);
  return arr;
}
function joinSections({ summary, roles, skills }){
  return [
    summary?.trim() ? `${summary.trim()}` : "",
    roles?.trim() ? `\n${roles.trim()}` : "",
    skills?.trim() ? `\n${skills.trim()}` : ""
  ].join("\n").trim() + "\n";
}
function toOxford(arr){
  if (arr.length <= 2) return arr.join(" & ");
  return `${arr.slice(0,-1).join(", ")} & ${arr[arr.length-1]}`;
}

// --------------- end ---------------
