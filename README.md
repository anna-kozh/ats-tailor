# ATS Tailor — OpenAI + Netlify (Option 1)

## What you get
- Static UI (`index.html`, `js/main.js`, `js/utils.js`)
- Serverless function (`netlify/functions/tailor.mjs`) that calls OpenAI safely
- Netlify config (`netlify.toml`)

## Deploy (GitHub → Netlify)
1) Push this folder to your GitHub repo (or replace your repo contents with it).
2) Netlify → Add new site → Import from Git → pick your repo.
3) Settings → Environment variables → add `OPENAI_API_KEY`.
4) Deploy. Your API endpoint becomes `/.netlify/functions/tailor`.

## Use
- Upload/paste resume + JD.
- Click **Analyze** → see score, gaps, suggestions.
- Click **Rewrite** → get a tailored resume draft.
