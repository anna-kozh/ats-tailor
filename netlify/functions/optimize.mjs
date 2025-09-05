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

const callOpenAI = async (apiKey, systemPrompt, userPrompt, isJson = true) => {
    const body = {
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
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
        const errorData = await response.json();
        console.error("OpenAI API Error:", errorData);
        throw new Error(`OpenAI API call failed: ${errorData.error.message}`);
    }
    const data = await response.json();
    const content = data.choices[0].message.content;
    return isJson ? JSON.parse(content) : content;
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
        const keywordSystemPrompt = `You are an AI data analyst. Your sole job is to analyze the provided job description and company values to extract the 15 most important keywords and skills a candidate must have. Return a single JSON object with this structure: {"keywords": ["...", "..."]}`;
        const keywordUserPrompt = `**JOB DESCRIPTION:**\n${jobDescription}\n\n---\n\n**COMPANY VALUES & CULTURE:**\n${companyValues || 'Not provided.'}`;
        const { keywords } = await callOpenAI(apiKey, keywordSystemPrompt, keywordUserPrompt);

        if (!keywords || keywords.length === 0) {
            throw new Error("Keyword extraction failed or returned no keywords.");
        }

        // --- PASS 2: THE GUARDED WRITER with Word Limits ---
        const writerSystemPrompt = `You are a master resume writer with strict guardrails and word limits. You will be given a candidate's full work history as a single block of text.

        **NON-NEGOTIABLE RULES:**
        1.  **PRESERVE FACTS:** You must parse the inventory to identify distinct jobs. For each, you MUST preserve the original \`company\`, \`role\`, and \`dates\` EXACTLY as they appear. DO NOT alter them.
        2.  **FOCUS ON ACCOMPLISHMENTS:** Your creative work is strictly confined to rewriting accomplishment bullet points to align with the job description and keywords.
        3.  **CREATE A SKILLS SECTION:** After Work Experience, add a 'Skills' section with the most relevant skills.
        4.  **ENFORCE WORD LIMITS:** To ensure the resume fits on one page, you MUST adhere to these strict limits:
            - **Professional Summary:** Maximum 65 words.
            - **Each of the first three jobs listed:** The entire 'accomplishments' section for each job (all bullet points combined) should be a maximum of 70 words.

        Your final output should be a complete resume as a single block of text, starting with a powerful Professional Summary (2-3 bullets), mentionting 12 years of experience, followed by Work Experience, and then the Skills section.
        `;
        const writerUserPrompt = `**CRITICAL KEYWORDS TO INCLUDE:**\n${keywords.join(', ')}\n\n---\n\n**JOB DESCRIPTION (for context):**\n${jobDescription}\n\n---\n\n**CANDIDATE'S FULL EXPERIENCE INVENTORY (PRESERVE FACTS):**\n${masterInventory}`;
        
        const finalResume = await callOpenAI(apiKey, writerSystemPrompt, writerUserPrompt, false);
        
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
        return { statusCode: 500, body: JSON.stringify({ error: error.message || 'An internal server error occurred.' }) };
    }
};

