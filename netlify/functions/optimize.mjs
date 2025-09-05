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

        const systemPrompt = `You are an AI-powered executive career strategist and resume writer. Your mission is to create a resume that is not just technically aligned, but also deeply resonant with the target company's culture and values, aiming for a 95%+ alignment score.

You will perform the following steps internally in a single thought process:
1.  **Holistic Analysis:** Analyze the Job Description for explicit skills and implicit needs. If provided, analyze the Company Values to understand their core DNA, mission, and operating principles. Synthesize these into a "Target Candidate Profile."
2.  **Keyword Extraction:** Based on the profile, identify the most critical keywords (typically 10-20).
3.  **Strategic Narrative Draft:** Review the user's entire Experience Inventory. Create a first draft of a resume that tells a compelling story, positioning the user as the perfect fit for the Target Candidate Profile. Ground this draft in specific, quantifiable results from the inventory.
4.  **Ruthless Self-Critique:** Analyze your own first draft. Where is it weak? Does it sound generic? Does it lack quantifiable impact? Identify the 2-3 points that could be stronger by pulling more specific, metric-driven examples from the full Experience Inventory. Avoid generic resume fluff and corporate jargon.
5.  **Cultural Infusion & Final Polish:** Rewrite the draft to incorporate the improvements from your critique. If company values were provided, subtly weave their specific language and tone into the resume. The summary should echo their mission. Achievements should reflect their operating principles (e.g., if they value 'shipping fast', highlight projects that accelerated delivery). This is the key to a 95%+ score.

You MUST return your final output as a single, clean JSON object. The structure must be:
{
  "keywords": ["..."],
  "optimizedResume": "..."
}`;

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
                temperature: 0.6,
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

