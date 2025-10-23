// ---- Hybrid scorer + tiny parser ----

// util: tiny stemmer
const stem = s => s
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g,' ')
  .replace(/\s+/g,' ')
  .trim()
  .replace(/\b(ing|ed|es|s)\b/g,'');

const WINDOW = 8;
const SECTION_MULT = { experience: 1.3, summary: 1.0, skills: 0.5 };

function windowHasAll(tokens, terms, w = WINDOW) {
  const idxs = terms.map(t => tokens.indexOf(t));
  if (idxs.some(i => i === -1)) return false;
  const min = Math.min(...idxs), max = Math.max(...idxs);
  return (max - min) <= w;
}

function detectNegation(tokens, hitIdx) {
  const span = tokens.slice(Math.max(0, hitIdx - 4), hitIdx + 5).join(' ');
  return /\b(no|not|without|lack|never|only exposure)\b/.test(span);
}

function scoreResume(resume, jdKeywords /* [{term, type, synonyms?, phrases?, tf?}] */, meta /* {sections:{summary, skills, experience:[{text, isRecent?}]}} */) {
  // Build weighted keywords
  const weighted = jdKeywords.map(k => {
    const base = 1 + (k.tf || 0);
    const typeBoost = k.type === 'hard' ? 2 : k.type === 'domain' ? 1.5 : k.type === 'tool' ? 1 : 0.5;
    return { ...k, weight: Math.min(5, base + typeBoost) };
  });

  // Tokenize sections
  const sec = {
    summary: stem(meta.sections.summary || '').split(/\s+/).filter(Boolean),
    skills: stem(meta.sections.skills || '').split(/\s+/).filter(Boolean),
    experience: (meta.sections.experience || []).map(e => ({
      tokens: stem(e.text || '').split(/\s+/).filter(Boolean),
      recencyBoost: e.isRecent ? 1.2 : 1.0
    }))
  };

  let total = 0, maxTotal = 0, expl = [];
  for (const kw of weighted) {
    const phrases = (kw.phrases || [kw.term]).map(stem);
    const terms = stem(kw.term).split(/\s+/).filter(Boolean);
    const syns = (kw.synonyms || []).map(stem);

    let best = null;

    const evalSection = (tokens, sectionName, recency = 1.0) => {
      // Tier A: phrase exact
      for (const p of phrases) {
        const idx = tokens.join(' ').indexOf(p);
        if (idx !== -1) {
          const contrib = kw.weight * 1.0 * SECTION_MULT[sectionName] * recency;
          best = { tier: 'A', section: sectionName, confidence: 0.95, contrib };
          return;
        }
      }
      // Tier B: token set within window
      if (!best && terms.length && windowHasAll(tokens, terms)) {
        const contrib = kw.weight * 0.8 * SECTION_MULT[sectionName] * recency;
        best = { tier: 'B', section: sectionName, confidence: 0.85, contrib };
      }
      // Tier C: synonym
      if (!best && syns.some(s => tokens.includes(s))) {
        const contrib = kw.weight * 0.6 * SECTION_MULT[sectionName] * recency;
        best = { tier: 'C', section: sectionName, confidence: 0.7, contrib };
      }
    };

    // Search sections
    sec.experience.forEach(e => evalSection(e.tokens, 'experience', e.recencyBoost));
    if (!best) evalSection(sec.summary, 'summary', 1.0);
    if (!best) evalSection(sec.skills, 'skills', 1.0);

    const maxForKw = kw.weight * 1.3; // best case: experience Tier A
    maxTotal += maxForKw;

    if (best) {
      // crude negation check around first term in summary (cheap)
      const hitIdx = sec.summary.indexOf(terms[0]);
      const isNeg = hitIdx !== -1 && detectNegation(sec.summary, hitIdx);
      const contribution = isNeg ? 0 : best.contrib;
      total += contribution;
      expl.push({
        term: kw.term,
        matched_tier: best.tier,
        section: best.section,
        contribution: +contribution.toFixed(2),
        confidence: best.confidence
      });
    } else {
      expl.push({ term: kw.term, matched_tier: null, section: null, contribution: 0, confidence: 0 });
    }
  }

  let score = maxTotal ? Math.min(100, Math.max(0, 100 * (total / maxTotal))) : 0;

  // stuffing penalty
  const hits = expl.filter(e => e.contribution > 0);
  const skillsHits = hits.filter(e => e.section === 'skills').length;
  if (hits.length && skillsHits / hits.length > 0.4) score *= 0.9;

  return { score: +score.toFixed(1), breakdown: expl };
}

// very lightweight section parser for MVP
function parseSections(text) {
  const raw = (text || '').replace(/\r/g, '');
  const lower = raw.toLowerCase();

  const getBlock = (label, fallback = '') => {
    const i = lower.indexOf(label);
    if (i === -1) return fallback;
    const rest = raw.slice(i + label.length);
    const next = rest.search(/\n[A-Z][A-Z \/\-&]{3,}\n/); // crude ALLCAPS header detector
    return next === -1 ? rest.trim() : rest.slice(0, next).trim();
  };

  const summary = getBlock('professional summary', '');
  const skills = getBlock('skills', '');
  const experienceBlock = getBlock('work experience', raw);

  const bullets = experienceBlock
    .split(/\n[\u2022\-\*]\s+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const currentYear = new Date().getFullYear();
  const experience = bullets.map(b => {
    const years = [...b.matchAll(/\b(20\d{2}|19\d{2})\b/g)].map(m => parseInt(m[1], 10));
    const maxYear = years.length ? Math.max(...years) : null;
    const isRecent = !!(maxYear && maxYear >= (currentYear - 4));
    return { text: b, isRecent };
  });

  return { sections: { summary, skills, experience } };
}

// --- JSON helper (strict schema) ---
async function callOpenAIJSON(apiKey, model, systemPrompt, userPrompt, schema, temperature=0.2, max_tokens=900){
  const body = {
    model,
    messages: [{role:'system', content: systemPrompt},{role:'user', content: userPrompt}],
    temperature,
    max_tokens,
    response_format: { type: "json_schema", json_schema: { name: "placement_plan", schema, strict: true } }
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{ 'Authorization': `Bearer ${apiKey}`, 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}



// NOTE: Added 'model' parameter to specify which OpenAI model to use
const callOpenAI = async (apiKey, model, systemPrompt, userPrompt, isJson = true) => {
    const body = {
        model: model, // Use the passed-in model
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 1800,
    };
    if (isJson) {
        body.response_format = { type: "json_object" };
    }
    
    // --- Logging added for better debugging ---
    console.log(`Calling OpenAI with model: ${model}`);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    console.log(`OpenAI response status: ${response.status}`);

    if (!response.ok) {
        // Log error details from OpenAI for debugging
        const errorData = await response.json().catch(() => ({ error: { message: 'Could not parse OpenAI error response.' } }));
        console.error("OpenAI API Error:", errorData);
        throw new Error(`OpenAI API call failed: ${errorData.error.message}`);
    }
    
    // --- Reliable JSON Parsing and Content Extraction ---
    const data = await response.json();
    const content = data.choices[0].message.content;
    
    try {
        return isJson ? JSON.parse(content) : content;
    } catch (e) {
        // Handles cases where the AI is asked for JSON but returns malformed text
        console.error("Failed to JSON.parse content:", content);
        throw new Error("AI returned malformed JSON despite instruction.");
    }
};


exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'OpenAI API key is not configured.' }) };

    try {
        const { resumeText: masterInventory, jobDescription, companyValues } = JSON.parse(event.body);
        if (!masterInventory || !jobDescription) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Experience Inventory and Job Description are required.' }) };
        }

        // --- PASS 1: THE STRATEGIST (Keyword Extraction) ---
        // CHANGED MODEL TO gpt-3.5-turbo FOR SPEED
        const keywordModel = 'gpt-4o'; 
        const keywordSystemPrompt = `You are an AI data analyst. Your sole job is to analyze the provided job description and company values to extract the 15 most important keywords and skills a candidate must have. Return a single JSON object with this structure: {"keywords": ["...", "..."]}`;
        const keywordUserPrompt = `**JOB DESCRIPTION:**\n${jobDescription}\n\n---\n\n**COMPANY VALUES & CULTURE:**\n${companyValues || 'Not provided.'}`;
        
        const { keywords } = await callOpenAI(apiKey, keywordModel, keywordSystemPrompt, keywordUserPrompt);

        if (!keywords || keywords.length === 0) {
            throw new Error("Keyword extraction failed or returned no keywords.");
        }

// --- PASS 1b: PLACEMENT PLANNER (map keywords to specific bullets) ---
const sections = parseSections(masterInventory);
const plannerSystem = `You are mapping JD keywords to the candidate's existing WORK EXPERIENCE bullets.
Create a placement plan that maximises truthful keyword coverage in EXPERIENCE first, then Summary or Skills only if needed.


HOW TO THINK
1) Build semantic clusters on the fly for each JD keyword using JD context and common variations.
   - Include synonyms, abbreviations, plural/singular, close paraphrases, and role-specific phrasing.
   - Example pattern: “project management” → “PM”, “program management”, “roadmapping”, “delivery management”.
2) Use evidence from the resume. Do not invent facts. Prefer explicit matches. Allow strong implication when activities prove the concept.

SEMANTIC EXPANSION RULE:
When building cluster_variants for each keyword, automatically include semantically related and domain-equivalent terms.

Use vector or lexical similarity, professional usage, and role-specific context to infer equivalence.
Example:
- "dynamic teams" → agile, cross-functional, startup, fast-paced, lean
- "responsible AI" → ethical AI, AI ethics, AI safety, fairness, bias mitigation
- "AI-enabled design" → AI-powered design, intelligent design tools, generative UX
- "cross-functional collaboration" → co-design, multidisciplinary, partnership with dev/product
- "algorithmic bias" → fairness, bias mitigation, inclusive AI

Treat these as *cluster_variants*.
Confidence:
- High if meaning and context align exactly (responsible AI ↔ ethical AI)
- Medium if approximate or context-dependent (dynamic teams ↔ startup culture)


Use embedding similarity threshold ≥0.75 to identify cluster_variants.



INFERENCE LADDER
- HIGH confidence:
  - Exact keyword in the bullet, or an unambiguous synonym from the cluster.
  - Or activity that directly demonstrates the concept (e.g., for security → threat modeling, audits; for sales → quota attainment; for data → SQL queries, model training; for design → usability testing, IA; for ops → SLAs, incident response; for marketing → campaign metrics).
- MEDIUM confidence:
  - Strong implication through tasks, outputs, or metrics that normally require the concept.
  - Title + activity pairing that makes the concept very likely.
- LOW confidence → SKIP:
  - Title alone without supporting action.
  - Vague phrasing like “exposure to”.
  - Future intent or unrelated context.

DISAMBIGUATION
- Match meaning, not string. Ignore homonyms if context differs.
- Beware near misses (e.g., “systems design” vs “design systems”, “research” vs “market research” if the JD means user research).
- Handle abbreviations and regional spelling.
- Negation: if the evidence span contains “no”, “not”, “without”, “lack”, “only exposure”, do not count.

MAPPING RULES
- Prefer EXPERIENCE bullets. Only use Summary/Skills if no suitable bullet with ≥ medium confidence.
- One keyword per bullet. Do not double-assign a bullet.
- Spread across roles. Avoid stacking more than three keywords in one role unless there are many bullets.
- Quote the exact evidence substring from the resume.
- If the match uses a cluster synonym, set confidence=medium unless the synonym is unambiguous and direct, then high.
- If nothing reaches ≥ medium confidence, set target="skip".

CLUSTERING INSTRUCTIONS (generate per keyword)
For each JD keyword:
- Produce 3–8 close variants and role-specific phrasings based on the JD domain.
- Include metric or artifact proxies that imply the concept (e.g., for leadership → “led X”, “mentored”, “headcount”, “OKRs”, “RACI”; for compliance → “audit”, “policy”, “ISO”, “SOC”, “GDPR”; for data → “SQL”, “dashboards”, “A/B test”, “ROC/AUC”; for engineering → “CI/CD”, “SLA/SLO”, “latency”, “throughput”; for product → “roadmap”, “PRD”, “release”, “impact metrics”).
- Use these variants when scanning bullets. Match only when context fits.

SECTION PREFERENCE
- EXPERIENCE > SUMMARY > SKILLS.
- If mapped to Summary or Skills, include once only.


OUTPUT JSON (strict)
{
  "placements": [
    {
      "keyword": "string",
      "cluster_variants": ["v1","v2","v3"],    // the variants you actually used to match
      "target": "experience|summary|skills|skip",
      "bullet_index": number|null,             // index within flattened experience bullets
      "evidence": "exact quote from resume bullet or ''",
      "confidence": "high|medium|low",
      "reason": "short why this mapping is valid (or why skipped)"
    }
  ]
}

PROCESS
1) For each keyword, build cluster_variants from JD context.
2) Scan EXPERIENCE bullets: exact → synonym → activity proxy. Pick the highest-confidence, most recent bullet.
3) If no ≥ medium in EXPERIENCE, try Summary then Skills.
4) If still no ≥ medium, mark skip.


`;
const plannerUser = `KEYWORDS: ${keywords.join(', ')}

WORK EXPERIENCE BULLETS:
${sections.sections.experience.map((e,i)=>`[${i}] ${e.text}`).join('\n')}

Return JSON:
{ "placements": [
  { "keyword": "string", "target": "experience|summary|skills|skip", "bullet_index": number|null, "evidence": "exact phrase from candidate text (or empty)" }
] }`;
const planSchema = {
  type:"object",
  properties:{
    placements:{
      type:"array",
      items:{
        type:"object",
        properties:{
          keyword:{type:"string"},
          target:{type:"string", enum:["experience","summary","skills","skip"]},
          bullet_index:{type:["integer","null"]},
          evidence:{type:"string"}
        },
        required:["keyword","target","bullet_index","evidence"],
        additionalProperties:false
      }
    }
  },
  required:["placements"],
  additionalProperties:false
};
const placementPlan = await callOpenAIJSON(apiKey, 'gpt-4o', plannerSystem, plannerUser, planSchema);



        // --- PASS 2: THE GUARDED WRITER with Word Limits ---
        // KEEPING gpt-4o FOR HIGH-QUALITY, COMPLEX WRITING
        const writerModel = 'gpt-4o'; 
        const writerSystemPrompt = `You are a senior resume strategist specializing in AI-assisted rewriting for high-impact design leadership roles. You will receive a candidate’s full work history as a single block of text.

**NON-NEGOTIABLE RULES**

** Preserve Facts: Parse the text into distinct jobs and keep each jobs company name, role title, and dates exactly as written.
Do not invent or alter employers, timelines, or industries.

** Rewrite Authentically
You may rewrite the summary, bullet points, and skills — not just summary or skills.
Use the original content as your factual base.
Integrate relevant keywords from the job description only when theres high confidence that the candidate truly has that experience.
Never fabricate achievements or claim ownership beyond whats supported.
Only reuse facts that exist in the candidate text. If a keyword is not clearly supported, skip it.


** Keyword Distribution:
Follow the provided Placement Plan strictly.
- If target=experience with bullet_index=N, rewrite that bullet N in place to naturally include the keyword.
- If target=summary or skills, include that keyword once only.
- If target=skip, do not use the keyword anywhere.
Limit to one keyword phrase per bullet.
Do not repeat the same keyword across bullets unless the meaning is different.
Do not add a keyword to Skills if it already appears in Experience.

** Aim for this keyword distribution:
Summary: 20-25%
Each job: Total  50-60%
Skills: 25-30%

** SKILLS DISCIPLINE (HARD CAP)
- Max 12–14 items.
- Only include: (a) items explicitly marked target="skills" in the plan, OR
  (b) items clearly evidenced in EXPERIENCE/SUMMARY (exact term or strong synonym).
- Do NOT mirror items already present in EXPERIENCE.
- Collapse synonyms to one canonical form (e.g., “UX” vs “User Experience” → pick one).
- Remove generic fluff (e.g., “Team Player”, “Hard Working”).
- If over the cap, keep the most job-relevant, de-duplicate, and drop the rest.


** Bias & Fairness Handling:
Detect and replace biased or exclusionary wording (e.g., gendered verbs, age-coded phrases, cultural idioms) with neutral, outcome-focused alternatives.
Keep tone inclusive, professional, and merit-based.
Replace biased phrases (rockstar, ninja, young, native English) with neutral equivalents. Avoid culture-coded idioms.
- Inclusive, outcome-focused. No culture-coded idioms.
- Leadership verbs: Led, Drove, Shaped, Operationalised, Scaled.
- Australian spelling.

** Leadership Tone:
Write with the confidence and clarity of a Lead Product Designer: ownership, impact, strategy, collaboration, and measurable outcomes.
Avoid soft qualifiers like helped, assisted, contributed unless they describe mentorship or cross-team collaboration.
Prefer verbs like Led, Drove, Shaped, Operationalised, Scaled. Avoid passive voice.


** Formatting & Word Limits:

*** Professional Summary: up to 70 words, 1–2 sentences, mention 12 years of experience.
*** Freelance: 40 words
*** Simpology: 80 words
*** SkoolBag: 80 words
*** ASG Group: 20 words
*** VoiceBox: 20 words
*** Work Experience total: ≤300 words.
*** Use bullet points for achievements only.
*** If over any limit, cut the lowest-value phrases first until within limits.

** Skills section: at the end, capitalize each skill (e.g., Design Strategy, Human-AI Interaction, UX Research).

** Style:
Use Australian spelling.
Keep tone clear, assertive, and concise — no filler, no self-praise.
Avoid jargon unless it clarifies expertise.

** OUTPUT FORMAT
A single text block containing:
*** Professional Summary
*** Work Experience (each job with rewritten bullet points)
*** Skills (final list, title-cased)

        `;
        const writerUserPrompt = `**CRITICAL KEYWORDS TO INCLUDE:**\n${keywords.join(', ')}\n\n---\n\n**JOB DESCRIPTION (for context):**\n${jobDescription}\n\n---\n\n**CANDIDATE'S FULL EXPERIENCE INVENTORY (PRESERVE FACTS):**\n${masterInventory}`;
        
        const finalResume = await callOpenAI(apiKey, writerModel, writerSystemPrompt, writerUserPrompt, false);
        
        // --- FINAL, RELIABLE SCORING ---
        // --- FINAL, EXPLAINABLE SCORING ---
const originalMeta = parseSections(masterInventory);
const rewrittenMeta = parseSections(finalResume);
const jdKeywords = keywords.map(k => ({ term: k, type: 'hard' })); // MVP typing

const originalEval = scoreResume(masterInventory, jdKeywords, originalMeta);
const optimizedEval = scoreResume(finalResume, jdKeywords, rewrittenMeta);

const usedInExperience = optimizedEval.breakdown.filter(b => b.section === 'experience' && b.contribution > 0).length;
const usedTotal = optimizedEval.breakdown.filter(b => b.contribution > 0).length;
if (usedTotal > 0 && (usedInExperience / usedTotal) < 0.6) {
  console.warn('Placement ratio too low; keywords concentrated outside Experience.');
  // Optional: trigger a second writer pass with a stronger instruction or show a UI warning.
}


function getMissingFromEval(keywords, optimizedEval){
  const norm = s => String(s || '').toLowerCase().trim();
  const zeroes = new Set(
    (optimizedEval?.breakdown || [])
      .filter(b => !b || b.contribution === 0 || !b.section)
      .map(b => norm(b.term || b.keyword || b.name))
  );
  return (keywords || []).filter(k => zeroes.has(norm(k)));
}



return {
    statusCode: 200,
    body: JSON.stringify({
        optimizedResume: finalResume,
        originalScore: originalEval.score,
        optimizedScore: optimizedEval.score,
        keywords,
        // NEW: expose missing so UI can highlight in red
        missing: getMissingFromEval(keywords, optimizedEval),
        originalScoreBreakdown: originalEval.breakdown,
        optimizedScoreBreakdown: optimizedEval.breakdown
    })
};

    } catch (error) {
        console.error('Function Error:', error);
        // Ensure error response is always valid JSON to avoid the client-side 'Unexpected end of JSON input'
        return { statusCode: 500, body: JSON.stringify({ error: error.message || 'An internal server error occurred.' }) };
    }
};