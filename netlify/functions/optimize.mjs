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

const callOpenAI = async (apiKey, systemPrompt, userPrompt) => {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.5,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error("OpenAI API Error:", errorData);
        throw new Error(`OpenAI API call failed: ${errorData.error.message}`);
    }

    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
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

        // --- PASS 1: THE STRATEGIST ---
        const strategySystemPrompt = `You are an AI executive career strategist. Your task is to analyze a candidate's materials against a job role and create a strategic plan for their resume.
        1.  **Analyze Holistically:** Analyze the Job Description, the candidate's full Experience Inventory, and the Company Values. Synthesize these into a "Target Candidate Profile."
        2.  **Extract Keywords:** Based on this profile, extract the 15 most critical keywords.
        3.  **Identify Strategic Themes:** Identify the top 3-5 core themes or narratives the resume MUST convey to be successful (e.g., 'Scaling systems from scratch', 'Driving business impact through design', 'Thriving in ambiguity').
        4.  **Map Evidence:** For each strategic theme, find the single most powerful, metric-driven example from the candidate's Experience Inventory that proves their capability in that theme.
        You MUST return your analysis as a single, clean JSON object with this exact structure:
        {"keywords": ["..."], "strategic_plan": {"themes": [{"theme": "...", "best_example_from_inventory": "..."}]}}`;
        
        const strategyUserPrompt = `**JOB DESCRIPTION:**\n${jobDescription}\n\n---\n\n**COMPANY VALUES & CULTURE:**\n${companyValues || 'Not provided.'}\n\n---\n\n**CANDIDATE'S EXPERIENCE INVENTORY:**\n${masterInventory}`;

        const strategyResult = await callOpenAI(apiKey, strategySystemPrompt, strategyUserPrompt);
        const keywords = strategyResult.keywords || [];
        
        // --- PASS 2: THE EXECUTOR ---
        const executionSystemPrompt = `You are an AI master resume writer. Your sole focus is execution. You will be given a strategic plan and all the source materials. Your job is to write the best possible resume based *exactly* on that plan.
        - The Professional Summary must be a concise, powerful narrative that introduces the strategic themes from the plan.
        - The Work Experience section must prominently feature the specific 'best examples' provided in the plan. Re-word and frame them for maximum impact.
        - Weave the keywords naturally throughout the document.
        - The tone should be confident and results-oriented. Avoid fluff.
        You MUST return your final output as a single, clean JSON object with this structure:
        {"optimizedResume": "..."}`;

        const executionUserPrompt = `**STRATEGIC PLAN TO EXECUTE:**\n${JSON.stringify(strategyResult.strategic_plan, null, 2)}\n\n---\n\n**FULL EXPERIENCE INVENTORY (for context):**\n${masterInventory}\n\n---\n\n**JOB DESCRIPTION (for context):**\n${jobDescription}`;
        
        const executionResult = await callOpenAI(apiKey, executionSystemPrompt, executionUserPrompt);
        const finalResume = executionResult.optimizedResume || "";

        // --- FINAL SCORING ---
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

