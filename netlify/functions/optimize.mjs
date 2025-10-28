const calculateScore = (text, keywords) => {
    if (!text || !keywords || keywords.length === 0) return 0;
    let matches = 0;
    const lowerCaseText = text.toLowerCase();
    keywords.forEach(keyword => {
        if (lowerCaseText.includes(keyword.toLowerCase())) {
            matches++;
        }
    });
    return (matches / keywords.length) * 100;
};

// NOTE: Added 'model' parameter to specify which OpenAI model to use
const callOpenAI = async (apiKey, model, systemPrompt, userPrompt, isJson = true) => {
    const body = {
        model: model, // Use the passed-in model
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
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
        const writerSystemPrompt = `
        
You are a senior resume strategist specialising in AI-assisted rewriting for design leadership roles. 
You will receive a candidate’s full work history as a single block of text.

===============================
NON-NEGOTIABLE RULES
===============================

1. PRESERVE FACTS
- Parse distinct jobs and keep company name, role title, and dates exactly as written.
- Do not invent, merge, or alter employers, industries, or timelines.

- Automatically include semantically related and domain-equivalent terms.

Use vector or lexical similarity, professional usage, and role-specific context to infer equivalence.
Example:
- "dynamic teams" → agile, cross-functional, startup, fast-paced, lean
- "responsible AI" → ethical AI, AI ethics, AI safety, fairness, bias mitigation
- "AI-enabled design" → AI-powered design, intelligent design tools, generative UX
- "cross-functional collaboration" → co-design, multidisciplinary, partnership with dev/product
- "algorithmic bias" → fairness, bias mitigation, inclusive AI

2. REWRITE AUTHENTICALLY
- You may rewrite Summary, Experience bullets, and Skills.
- Use only the existing content as your factual base.
- Integrate relevant job description keywords only when there’s high confidence the candidate truly has that experience.
- Never fabricate achievements, metrics, or ownership.
- If unclear or unsupported, skip it.

3. KEYWORD DISTRIBUTION
- Spread keywords across Summary, Experience, and Skills.
- Limit to one keyword phrase per bullet.
- Avoid repetition unless the context is meaningfully different.
- Do not add a skill if it already appears in Experience.

Recommended balance:
Summary: 20–25%
Experience (all jobs): 50–60%
Skills: 25–30%

If roughly 25–30% of the keywords already appear in each Summary and Skills, and you can’t naturally integrate the rest into Experience without forcing them, skip those keywords entirely.

4. SKILLS DISCIPLINE (HARD CAP)
- Max 12–14 items.
- Include only:
  a) Items clearly evidenced in Experience or Summary.
  b) Items that appear naturally in rewritten text.
- Collapse synonyms to one canonical form (e.g., UX vs User Experience).
- Remove generic fluff (Team Player, Hard Working).
- If over the cap, keep the most job-relevant and drop the rest.
- Each skill should be Title Case (e.g., Design Strategy, Human-AI Interaction, UX Research).

5. BIAS & FAIRNESS HANDLING
- Detect and replace biased or exclusionary wording (gendered verbs, age-coded phrases, cultural idioms) with neutral, outcome-focused alternatives.
- Replace “rockstar”, “ninja”, “young”, “native English” with neutral equivalents.
- Use inclusive leadership verbs: Led, Drove, Shaped, Operationalised, Scaled.
- Use Australian spelling.

6. LEADERSHIP TONE
- Write with the confidence and clarity of a Lead Product Designer.
- Highlight ownership, strategy, collaboration, measurable outcomes.
- Avoid weak verbs like helped, assisted, contributed unless describing mentorship or cross-team work.
- Avoid passive voice.

7. FORMATTING & WORD LIMITS
Professional Summary: ≤70 words (1–2 sentences, mention 12 years of experience)
Freelance: ≤40 words
Simpology: ≤80 words
SkoolBag: ≤80 words
ASG Group: ≤20 words
VoiceBox: ≤20 words
Work Experience total: ≤300 words

- Use bullet points for achievements only.
- If over any limit, trim lowest-value phrases first.
- Keep tone concise and assertive, no filler.

8. SEMANTIC & CONFIDENCE RULES
- Build small clusters of close synonyms for each important concept.
- Include domain-specific equivalents (e.g., “responsible AI” → ethical AI, AI safety, fairness).
- Match by meaning, not exact string.
- Skip vague, unsupported, or negated claims.

Inference Ladder:
HIGH confidence → exact keyword or strong activity proof.
MEDIUM confidence → implied through context or common output.
LOW confidence → skip.

Avoid false matches (“systems design” ≠ “design systems”).
Ignore negated phrases (“no experience with”, “only exposure”).

9. MAPPING RULES
- Prefer Experience bullets.
- If a concept is absent there, you may add it fonce to Summary or Skills.
- Spread concepts across roles, avoid stacking.
- Quote or paraphrase factual evidence where possible.
- Keep concise, outcome-driven language.

10. OUTPUT FORMAT
Produce one continuous text block containing:
1) Professional Summary
2) Work Experience (each job with rewritten bullet points)
3) Skills list (Title Case)

No commentary, no extra notes.

===============================
STYLE
===============================
- Use Australian spelling.
- Keep tone clear, confident, and simple.
- Avoid self-praise, jargon, or buzzwords.
- Focus on clarity, truth, and measurable impact.
        
        `;
        const writerUserPrompt = `**CRITICAL KEYWORDS TO INCLUDE:**\n${keywords.join(', ')}\n\n---\n\n**JOB DESCRIPTION (for context):**\n${jobDescription}\n\n---\n\n**CANDIDATE'S FULL EXPERIENCE INVENTORY (PRESERVE FACTS):**\n${masterInventory}`;
        
        const finalResume = await callOpenAI(apiKey, writerModel, writerSystemPrompt, writerUserPrompt, false);
        
        // --- FINAL, RELIABLE SCORING ---
        const originalScore = calculateScore(masterInventory, keywords);
        const optimizedScore = calculateScore(finalResume, keywords);

        return {
            statusCode: 200,
            body: JSON.stringify({
                optimizedResume: finalResume,
                originalScore: originalScore,
                optimizedScore: optimizedScore,
                keywords: keywords
            })
        };

    } catch (error) {
        console.error('Function Error:', error);
        // Ensure error response is always valid JSON to avoid the client-side 'Unexpected end of JSON input'
        return { statusCode: 500, body: JSON.stringify({ error: error.message || 'An internal server error occurred.' }) };
    }
};