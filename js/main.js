const el = (id) => document.getElementById(id);
const $resume = el('resume');
const $jd = el('jd');
const $ats = el('atsSelect');
const $rewrite = el('rewriteBtn');
const $status = el('status');
const $v2 = el('v2');
const $v1Echo = el('v1Echo');
const $scoreV1 = el('scoreV1');
const $scoreV2 = el('scoreV2');
const $debug = el('debug');
const $missingChips = el('missingChips');


function setStatus(msg) { $status.textContent = msg; }
function clearScores() {
$scoreV1.textContent = 'v1: —';
$scoreV2.textContent = 'v2: —';
}
function setScore(elm, label, score) {
elm.textContent = `${label}: ${Math.round(score)}`;
elm.classList.remove('ok','warn');
elm.classList.add(score >= 90 ? 'ok' : 'warn');
}


// --- Deterministic Scorer (client-side, matches server logic conceptually) ---
const DEFAULT_SYNONYMS = {
'ux': ['user experience'],
'ui': ['user interface'],
'llm': ['large language model','foundation model'],
'genai': ['generative ai','gen ai'],
'rag': ['retrieval augmented generation','retrieval-augmented generation'],
'a/b': ['ab testing','a b testing','experiment'],
};


function tokenize(text) {
return text
.toLowerCase()
.replace(/[^a-z0-9+/#.&\-\s]/g, ' ')
.split(/\s+/)
.filter(Boolean);
}


function unique(arr) { return [...new Set(arr)]; }


function extractKeywords(jd) {
// naive pull of likely keywords from JD sections
const tokens = tokenize(jd);
const stop = new Set(['and','or','the','a','to','for','with','in','of','on','at','by','is','are','as','be','this','that','an','will','can','we','you','our','your','from','into','across','over','within']);
const freq = new Map();
for (const t of tokens) {
if (stop.has(t) || t.length < 2) continue;
freq.set(t, (freq.get(t) || 0) + 1);
}
// pick top 60 distinct terms, keep tool-ish tokens
const top = [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 120).map(([t])=>t);
// merge synonyms
const expanded = new Set(top);
for (const [k, syns] of Object.entries(DEFAULT_SYNONYMS)) {
if (expanded.has(k)) syns.forEach(s => expanded.add(s));
}
return unique([...expanded]);
}


function scoreAgainst(jdKeywords, resumeText, atsProfile='auto') {
const resTokens = new Set(tokenize(resumeText));
const mustHaves = jdKeywords.slice(0, 35); // heuristic: first 35 most-frequent terms
let found = 0; const missing = [];
$rewrite.addEventListener('click', runRewrite);}