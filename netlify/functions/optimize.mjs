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

const callOpenAI = async (apiKey, messages, isJson = false) => {
    const body = {
        model: 'gpt-4o',
        messages,
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
    return data.choices[0].message.content;
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

        // STEP 1: The Analyst - Extract Keywords
        const keywordContent = await callOpenAI(apiKey, [
            { role: 'system', content: 'You are an expert data analyst. Extract the top 15 most important keywords from the job description. Return a JSON object like {"keywords": ["React", "Project Management"]}.' },
            { role: 'user', content: jobDescription }
        ], true);
        const { keywords } = JSON.parse(keywordContent);

        // Score original inventory
        const originalScore = calculateScore(masterInventory, keywords);

        // STEP 2: The First-Draft Writer - Initial Optimization
        const firstDraft = await callOpenAI(apiKey, [
            { role: 'system', content: 'You are a resume writer. Create a professional resume using the provided inventory, tailored to the job description.' },
            { role: 'user', content: `JOB DESCRIPTION:\n${jobDescription}\n\n---\n\nEXPERIENCE INVENTORY:\n${masterInventory}` }
        ]);

        // STEP 3: The Ruthless Critic - Find Weaknesses
        const critiqueContent = await callOpenAI(apiKey, [
            { role: 'system', content: 'You are a ruthless hiring manager. Analyze the draft resume against the keywords and the full inventory. Identify the top 3 weakest keywords in the draft. For each, find a stronger, more quantifiable accomplishment from the full inventory that should be used instead. Return a JSON object like {"critique": [{"weak_keyword": "...", "suggested_improvement_from_inventory": "..."}]}.' },
            { role: 'user', content: `KEYWORDS: ${keywords.join(', ')}\n\n---\n\nDRAFT RESUME:\n${firstDraft}\n\n---\n\nFULL INVENTORY:\n${masterInventory}` }
        ], true);
        const { critique } = JSON.parse(critiqueContent);

        // STEP 4: The Master Writer - Final Polish
        const finalResume = await callOpenAI(apiKey, [
            { role: 'system', content: 'You are a master resume writer. Create the final, polished resume by incorporating the following critical feedback into the first draft. This is the final version, make it perfect.' },
            { role: 'user', content: `CRITICAL FEEDBACK:\n${JSON.stringify(critique, null, 2)}\n\n---\n\nFIRST DRAFT:\n${firstDraft}\n\n---\n\nFULL INVENTORY (for context):\n${masterInventory}\n\n---\n\nJOB DESCRIPTION (for context):\n${jobDescription}` }
        ]);
        
        // Final score
        const optimizedScore = calculateScore(finalResume, keywords);

        return {
            statusCode: 200,
            body: JSON.stringify({
                optimizedResume: finalResume,
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

