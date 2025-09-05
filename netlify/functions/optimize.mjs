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

        // --- PASS 2: THE HYBRID ATS & HUMAN-FOCUSED WRITER ---
        const writerSystemPrompt = `You are an AI resume optimizer with a two-part goal: First, to achieve a high score on an Applicant Tracking System (ATS), and second, to write a resume that is compelling and impressive to a human hiring manager.

        **NON-NEGOTIABLE RULES:**
        1.  **CREATE CORE COMPETENCIES FOR ATS:** Start the resume with a "Core Competencies" or "Skills" section. This should be a dense list of the most critical keywords to ensure a high ATS score.
        2.  **WRITE FOR HUMAN IMPACT:** After the competencies section, write a powerful Professional Summary and Work Experience section. Here, you must weave the keywords in naturally. Focus on a compelling narrative, quantifiable achievements, and professional tone. Avoid robotic "keyword stuffing."
        3.  **PRESERVE FACTS:** You must parse the inventory to identify distinct jobs. For each, you MUST preserve the original \`company\`, \`role\`, and \`dates\` EXACTLY as they appear.
        4.  **SCORE YOUR WORK:** After writing the resume, you MUST score it by calculating the percentage of the provided keywords that are present in your final text.

        Your final output should be a complete, ATS-optimized, and human-readable resume, along with your calculated score, returned as a single JSON object with this exact structure:
        {"optimizedResume": "...", "optimizedScore": ...}
        `;
        const writerUserPrompt = `**CRITICAL KEYWORDS TO INCLUDE & SCORE AGAINST:**\n${keywords.join(', ')}\n\n---\n\n**JOB DESCRIPTION (for context):**\n${jobDescription}\n\n---\n\n**CANDIDATE'S FULL EXPERIENCE INVENTORY (PRESERVE FACTS):**\n${masterInventory}`;
        
        const { optimizedResume, optimizedScore } = await callOpenAI(apiKey, writerSystemPrompt, writerUserPrompt, true);
        
        // --- FINAL, RELIABLE SCORING ---
        const originalScore = calculateScore(masterInventory, keywords);

        return {
            statusCode: 200,
            body: JSON.stringify({
                optimizedResume: optimizedResume,
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

