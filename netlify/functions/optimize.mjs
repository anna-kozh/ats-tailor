// netlify/functions/optimize.mjs

// ---- Hybrid scorer + tiny parser ----

// util: tiny stemmer
const stem = s => s
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\b(ing|ed|es|s)\b/g, '');

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
  const weighted = jdKeywords.map(k => {
    const base = 1 + (k.tf || 0);
    const typeBoost = k.type === 'hard' ? 2 : k.type === 'domain' ? 1.5 : k.type === 'tool' ? 1 : 0.5;
    return { ...k, weight: Math.min(5, base + typeBoost) };
  });

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
async function callOpenAIJSON(apiKey, model, systemPrompt, userPrompt, schema, temperature = 0.2, max_tokens = 900) {
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    temperature,
    max_tokens,
    response_format: { type: "json_schema", json_schema: { name: "placement_plan", schema, strict: true } }
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
}

// NOTE: Added 'model' parameter to specify which OpenAI model to use
const callOpenAI = async (apiKey, model, systemPrompt, userPrompt, isJson = true) => {
  const body = {
    model: model,
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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: 'Could not parse OpenAI error response.' } }));
    console.error("OpenAI API Error:", errorData);
    throw new Error(`OpenAI API call failed: ${errorData.error.message}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;

  try {
    return isJson ? JSON.parse(content) : content;
  } catch (e) {
    console.error("Failed to JSON.parse content:", content);
    throw new Error("AI returned malformed JSON despite instruction.");
  }
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'OpenAI API key is not configured.' }) };

  try {
    const { resumeText: masterInventory, jobDescription, companyValues } = JSON.parse(event.body || '{}');
    if (!masterInventory || !jobDescription) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Experience Inventory and Job Description are required.' }) };
    }

    // --- PASS 1: THE STRATEGIST (Keyword Extraction) ---
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
Rules:
- Prefer mapping to an existing bullet in WORK EXPERIENCE when evidence exists.
- Only map to Summary/Skills if there is no suitable bullet.
- If no evidence for a keyword anywhere, mark as "skip".
- Never invent facts.`;
    const plannerUser = `KEYWORDS: ${keywords.join(', ')}

WORK EXPERIENCE BULLETS:
${sections.sections.experience.map((e, i) => `[${i}] ${e.text}`).join('\n')}

Return JSON:
{ "placements": [
  { "keyword": "string", "target": "experience|summary|skills|skip", "bullet_index": number|null, "evidence": "exact phrase from candidate text (or empty)" }
] }`;
    const planSchema = {
      type: "object",
      properties: {
        placements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              keyword: { type: "string" },
              target: { type: "string", enum: ["experience", "summary", "skills", "skip"] },
              bullet_index: { type: ["integer", "null"] },
              evidence: { type: "string" }
            },
            required: ["keyword", "target", "bullet_index", "evidence"],
            additionalProperties: false
          }
        }
      },
      required: ["placements"],
      additionalProperties: false
    };
    const placementPlan = await callOpenAIJSON(apiKey, 'gpt-4o', plannerSystem, plannerUser, planSchema);

    // --- PASS 2: BULLET REWRITER (JSON, edits in place) ---
    const bullets = sections.sections.experience.map(e => e.text);

    const bulletSchema = {
      type: "object",
      properties: {
        updated_bullets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              before: { type: "string" },
              after: { type: "string" },
              used_keywords: { type: "array", items: { type: "string" } }
            },
            required: ["index", "before", "after"]
          }
        },
        summary_additions: { type: "array", items: { type: "string" } },
        skills_additions: { type: "array", items: { type: "string" } }
      },
      required: ["updated_bullets"],
      additionalProperties: false
    };

    const bulletSystem = `You edit only the WORK EXPERIENCE bullets, in place.
Rules:
- Follow the PLACEMENT PLAN strictly.
- For target=experience with bullet_index=N: rewrite bullet N to naturally include that keyword. Keep the original claim; no new facts.
- One keyword phrase max per bullet. No stuffing. No invented metrics, teams, tools, dates, titles.
- If a keyword maps to summary/skills, list it in the appropriate *_additions array (once each), do not touch bullets for those.
- Keep Australian spelling. Leadership tone. Active voice.
- Output strict JSON per schema.`;

    const bulletUser = `WORK EXPERIENCE BULLETS (indexed):
${bullets.map((b, i) => `[${i}] ${b}`).join('\n')}

PLACEMENT PLAN (must follow):
${JSON.stringify(placementPlan, null, 2)}

JOB DESCRIPTION (context only):
${jobDescription}

CANDIDATE TEXT (source of truth):
${masterInventory}`;

    const bulletEdits = await callOpenAIJSON(apiKey, 'gpt-4o', bulletSystem, bulletUser, bulletSchema);

    // defaults to avoid crashes if model returns minimal JSON
    bulletEdits.updated_bullets = Array.isArray(bulletEdits.updated_bullets) ? bulletEdits.updated_bullets : [];
    bulletEdits.summary_additions = Array.isArray(bulletEdits.summary_additions) ? bulletEdits.summary_additions : [];
    bulletEdits.skills_additions = Array.isArray(bulletEdits.skills_additions) ? bulletEdits.skills_additions : [];

    // --- Compose final resume text from original sections + edits ---
    function composeFinalResume(originalSections, bulletEdits) {
      // apply bullet edits
      const updated = [...originalSections.experience.map(e => e.text)];
      for (const u of bulletEdits.updated_bullets) {
        if (Number.isInteger(u.index) && u.index >= 0 && u.index < updated.length) {
          updated[u.index] = u.after.trim();
        }
      }

      // summary: append small, safe additions if provided (once, short)
      let summary = (originalSections.summary || '').trim();
      const sumAdds = (bulletEdits.summary_additions || [])
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (sumAdds.length && summary.length) {
        const add = Array.from(new Set(sumAdds)).join(', ');
        summary = summary.replace(/\s+$/, '');
        if (!/[.!?]$/.test(summary)) summary += '.';
        summary += ` Focus areas: ${add}.`;
      }

      // skills: merge additions (dedupe)
      const existingSkills = (originalSections.skills || '').trim();
      const existingList = existingSkills
        ? existingSkills.split(/\s*[,\n]\s*/).map(s => s.trim()).filter(Boolean)
        : [];
      const skillAdds = Array.from(new Set((bulletEdits.skills_additions || []).map(s => s.trim()).filter(Boolean)));
      const mergedSkills = Array.from(new Set([...existingList, ...skillAdds]));
      const skillsStr = mergedSkills.join(', ');

      // build text
      const bulletsText = updated.map(b => `• ${b}`).join('\n');
      const out = [
        '**Professional Summary**',
        summary || originalSections.summary || '',
        '',
        '**Work Experience**',
        bulletsText,
        '',
        '**Skills**',
        skillsStr || existingSkills
      ].join('\n');
      return out.trim();
    }

    // --- FINAL, EXPLAINABLE SCORING ---
    const finalResume = composeFinalResume(sections.sections, bulletEdits);
    const originalMeta = parseSections(masterInventory);
    const rewrittenMeta = parseSections(finalResume);
    const jdKeywords = keywords.map(k => ({ term: k, type: 'hard' })); // MVP typing

    const originalEval = scoreResume(masterInventory, jdKeywords, originalMeta);
    const optimizedEval = scoreResume(finalResume, jdKeywords, rewrittenMeta);

    // Ensure ≥60% of used keywords landed in Experience
    const used = optimizedEval.breakdown.filter(b => b.contribution > 0);
    const usedInExp = used.filter(b => b.section === 'experience').length;
    const placementWarning = (used.length > 0 && (usedInExp / used.length) < 0.6)
      ? 'Keywords concentrated outside Experience. Consider retrying with stricter plan.'
      : null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        optimizedResume: finalResume,
        originalScore: originalEval.score,
        optimizedScore: optimizedEval.score,
        keywords,
        originalScoreBreakdown: originalEval.breakdown,
        optimizedScoreBreakdown: optimizedEval.breakdown,
        placementWarning
      })
    };

  } catch (error) {
    console.error('Function Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message || 'An internal server error occurred.' }) };
  }
};
