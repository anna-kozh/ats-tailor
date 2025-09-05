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
        const { resumeText: masterInventory, jobDescription } = JSON.parse(event.body);
        if (!masterInventory || !jobDescription) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Experience Inventory and Job Description are required.' }) };
        }

        const systemPrompt = `You are an AI-powered resume optimization agent. Your goal is to produce a final, highly-optimized resume that achieves a near-perfect score.

You will perform the following steps internally:
1.  **Analyze & Identify Keywords:** First, identify the top 15 most important keywords and concepts from the provided job description.
2.  **Create First Draft:** Based on the user's full Experience Inventory, create a strong first draft of a resume tailored to the job description.
3.  **Self-Critique:** Ruthlessly analyze your own first draft against the keywords. Identify the 2-3 weakest points where the resume lacks impact or metric-driven results. Then, find stronger, more quantifiable accomplishments from the FULL Experience Inventory that would be a better fit.
4.  **Final Rewrite:** Generate the final, polished resume by incorporating the improvements from your self-critique.

You MUST return your final output as a single, clean JSON object with no other text. The JSON object must have this exact structure:
{
  "keywords": ["..."],
  "originalScore": ...,
  "optimizedScore": ...,
  "optimizedResume": "..."
}`;

        const userPrompt = `**JOB DESCRIPTION:**\n${jobDescription}\n\n---\n\n**EXPERIENCE INVENTORY:**\n${masterInventory}`;
        
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

        // We need to re-calculate the scores here to ensure they are accurate and not hallucinated by the AI.
        const keywords = content.keywords || [];
        const finalResume = content.optimizedResume || "";

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

