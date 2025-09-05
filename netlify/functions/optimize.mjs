exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'OpenAI API key is not configured.' })
        };
    }

    try {
        const { resumeText, jobDescription } = JSON.parse(event.body);

        if (!resumeText || !jobDescription) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Resume and Job Description are required.' })
            };
        }

        const systemPrompt = `You are an expert career coach and professional resume writer specializing in the tech industry. Your task is to rewrite a user's resume to be perfectly tailored for a specific job description.

        Instructions:
        1.  **Analyze and Mirror:** Deeply analyze the job description to identify key skills, technologies, responsibilities, and company values. Mirror this language throughout the rewritten resume.
        2.  **Structure and Prioritize:** Restructure the resume to highlight the most relevant experiences. Create a powerful "Professional Summary" that acts as an elevator pitch.
        3.  **Quantify and Impact:** Rephrase bullet points to be action-oriented and results-driven. Use strong action verbs and quantify achievements with metrics.
        4.  **Tone and Keywords:** Adopt the tone of a high-performing candidate and ensure the resume is rich with keywords from the job description for ATS.
        5.  **Format:** Output the result as a complete, ready-to-use resume in clean Markdown format. Do not include any conversational text, only the resume content itself.`;
        
        const userPrompt = `**JOB DESCRIPTION:**\n${jobDescription}\n\n---\n\n**ORIGINAL RESUME:**\n${resumeText}`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.5,
                max_tokens: 2048,
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('OpenAI API Error:', data);
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: data.error?.message || 'Failed to get a response from OpenAI.' })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify(data)
        };

    } catch (error) {
        console.error('Function Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred.' })
        };
    }
};
