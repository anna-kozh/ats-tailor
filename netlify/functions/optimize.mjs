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

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'OpenAI API key is not configured.' }) };

    try {
        const { resumeText: masterInventory, jobDescription, companyValues } = JSON.parse(event.body);
        if (!masterInventory || !jobDescription) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Experience Inventory and Job Description are required.' }) };
        }

        const systemPrompt = `You are an AI executive career strategist. Your goal is to produce a resume with a 95%+ alignment score by performing a sophisticated "Chain-of-Thought" process internally before writing.

        **Internal Thought Process (DO NOT output this part):**
        1.  **Holistic Profile Synthesis:** First, I will analyze the Job Description for skills, the Company Values for cultural DNA, and the Experience Inventory for proof. I will synthesize these into a "Target Candidate Profile."
        2.  **Strategic Theme Identification:** Based on the profile, I will identify the 3-5 core themes a winning resume must convey (e.g., 'Drives business impact with design,' 'Builds scalable systems from scratch').
        3.  **Evidence Mapping:** For each theme, I will scan the entire Experience Inventory and select the most powerful, metric-driven accomplishment that serves as concrete proof for that theme.
        4.  **Keyword Extraction:** I will then generate a list of the 15 most critical keywords that align with my strategic analysis.
        
        **Final Execution (This is what you WILL output):**
        After completing my internal strategic analysis, I will write the resume.
        - The Professional Summary will be a powerful narrative built around the strategic themes I identified.
        - The Work Experience section will prominently feature the specific "best evidence" accomplishments I mapped to those themes, re-written for maximum impact.
        - I will then score the original inventory and my final, optimized resume against the keywords I extracted.
        
        You MUST return your final output as a single, clean JSON object with this exact structure:
        {"keywords": ["..."], "originalScore": ..., "optimizedScore": ..., "optimizedResume": "..."}`;
        
        const userPrompt = `**JOB DESCRIPTION:**\n${jobDescription}\n\n---\n\n**COMPANY VALUES & CULTURE:**\n${companyValues || 'Not provided.'}\n\n---\n\n**CANDIDATE'S EXPERIENCE INVENTORY:**\n${masterInventory}`;

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
        const content = JSON.parse(data.choices[0].message.content);

        // We trust the AI's generated scores in this more advanced model, but we still need to provide the data for the UI.
        const keywords = content.keywords || [];
        const finalResume = content.optimizedResume || "";
        const originalScore = content.originalScore || calculateScore(masterInventory, keywords);
        const optimizedScore = content.optimizedScore || calculateScore(finalResume, keywords);

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

