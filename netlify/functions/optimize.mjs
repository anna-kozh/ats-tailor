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
        const writerSystemPrompt = `You are a master resume writer with strict guardrails and word limits. You will be given a candidate's full work history as a single block of text.

        **NON-NEGOTIABLE RULES:**
        1.  **PRESERVE FACTS:** You must parse the inventory to identify distinct jobs. For each, you MUST preserve the original \`company\`, \`role\`, and \`dates\` EXACTLY as they appear. DO NOT alter them.
        2.  **FOCUS ON ACCOMPLISHMENTS:** Your creative work is strictly confined to rewriting accomplishment bullet points to align with the job description and keywords.
        3.  **BULLET POINTS - WORD COUNT:** Freelance (40 words), Simpology (80 words), SkoolBag (80 words), ASG GROUP (20 words), VoiceBox (20 words)
        4. **CREATE A SKILLS SECTION:** After Work Experience, add a 'Skills' section with the most relevant skills where each word starts with a capital letter (e.g. Design, Story Telling, Wireframes).
        5.  **ENFORCE WORD LIMITS:** To ensure the resume fits on one page, you MUST adhere to these strict limits:
        6.  **Professional Summary:** Maximum 70 words and 1-2 sentences, mentionting 12 years of experience
        7.  **Work Experience:** the whole Work Experience section shouldn't be more than 300 words.
        8.  **DO NOT INVENT:** do not make up industries or experience that are not mentioned in the Master Inventory. 
        9. Use Australian spelling and terminology.


        Your final output should be a complete resume as a single block of text, starting with a powerful Professional Summary,followed by Work Experience, and then the Skills section.
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