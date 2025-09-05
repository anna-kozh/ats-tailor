// --- Helper function for scoring ---
const calculateScore = (text, keywords) => {
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
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'OpenAI API key is not configured.' }) };
    }

    try {
        const { resumeText, jobDescription } = JSON.parse(event.body);
        if (!resumeText || !jobDescription) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Resume and Job Description are required.' }) };
        }

        // --- STEP 1: Extract Keywords from Job Description ---
        const keywordExtractionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert data analyst. Your task is to extract the top 15 most important keywords, skills, and concepts from the provided job description. Return them as a clean JSON array of strings. For example: ["React", "Project Management", "B2B SaaS"]. Do not include any other text.'
                    },
                    {
                        role: 'user',
                        content: jobDescription
                    }
                ],
                response_format: { type: "json_object" }
            })
        });

        const keywordData = await keywordExtractionResponse.json();
        if (!keywordExtractionResponse.ok) {
            throw new Error('Failed to extract keywords from job description.');
        }
        
        // The API in JSON mode often wraps the array in an object, so we need to find the array.
        const keywordsText = keywordData.choices[0].message.content;
        const keywordsObject = JSON.parse(keywordsText);
        const keywords = Object.values(keywordsObject)[0]; // Get the first value, which should be the array.
        
        // --- STEP 2: Score Original Resume ---
        const originalScore = calculateScore(resumeText, keywords);

        // --- STEP 3: Optimize the Resume ---
        const optimizationResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `You are an expert career coach and professional resume writer specializing in the tech industry. Rewrite the user's resume to be perfectly tailored for the provided job description, making sure to incorporate as many of the key skills and concepts as naturally as possible. Output only the rewritten resume in clean Markdown format.`
                    },
                    {
                        role: 'user',
                        content: `**JOB DESCRIPTION:**\n${jobDescription}\n\n---\n\n**ORIGINAL RESUME:**\n${resumeText}`
                    }
                ],
                temperature: 0.5,
                max_tokens: 2048,
            })
        });

        const optimizationData = await optimizationResponse.json();
        if (!optimizationResponse.ok) {
            throw new Error('Failed to optimize the resume.');
        }
        const optimizedResume = optimizationData.choices[0].message.content;

        // --- STEP 4: Score Optimized Resume ---
        const optimizedScore = calculateScore(optimizedResume, keywords);

        // --- STEP 5: Return the full payload ---
        return {
            statusCode: 200,
            body: JSON.stringify({
                optimizedResume,
                originalScore,
                optimizedScore,
                keywords
            })
        };

    } catch (error) {
        console.error('Function Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message || 'An internal server error occurred.' }) };
    }
};

