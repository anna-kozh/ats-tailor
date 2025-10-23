// ---- Hybrid scorer + tiny parser ----

// util: tiny stemmer
const stem = s => s
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g,' ')
  .replace(/\s+/g,' ')
  .trim()
  .replace(/\b(ing|ed|es|s)\b/g,'');

const WINDOW = 8;
const SECTION_MULT = { experience: 1.3, summary: 1.0, skills: 0.7 };

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
Spread aligned keywords across bullet points, summary, and skills.
Prioritize natural, contextual use within work experience, not keyword stuffing.
Limit to one keyword phrase per bullet.
Do not repeat the same keyword across bullets unless the meaning is different.
Budget keywords: 60% in Experience, 25% in Summary, 15% in Skills.


** Bias & Fairness Handling:
Detect and replace biased or exclusionary wording (e.g., gendered verbs, age-coded phrases, cultural idioms) with neutral, outcome-focused alternatives.
Keep tone inclusive, professional, and merit-based.
Replace biased phrases (rockstar, ninja, young, native English) with neutral equivalents. Avoid culture-coded idioms.


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
*** Skills
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

return {
    statusCode: 200,
    body: JSON.stringify({
        optimizedResume: finalResume,
        originalScore: originalEval.score,
        optimizedScore: optimizedEval.score,
        keywords,
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