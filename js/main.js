// js/main.js
import { readDocxAsText, readTextFile, downloadText } from './utils.js';

const el = {
  resumeFile: document.getElementById('resumeFile'),
  jdFile: document.getElementById('jdFile'),
  resumeText: document.getElementById('resumeText'),
  jdText: document.getElementById('jdText'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  rewriteBtn: document.getElementById('rewriteBtn'),
  status: document.getElementById('status'),
  scoreBox: document.getElementById('scoreBox'),
  rewritten: document.getElementById('rewritten'),
  rewriteStatus: document.getElementById('rewriteStatus'),
  rewriteScoreBox: document.getElementById('rewriteScoreBox'),
  showDiffBtn: document.getElementById('showDiffBtn'),
  diffBox: document.getElementById('diffBox'),
  diffHint: document.getElementById('diffHint'),
  copyBtn: document.getElementById('copyBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  suggestionsBox: document.getElementById('suggestionsBox')
};

let lastOriginal = '';
let lastRewritten = '';

function ensureSuggestionsBox(){
  if (!el.suggestionsBox) {
    const box = document.createElement('div');
    box.id = 'suggestionsBox';
    el.rewriteScoreBox?.insertAdjacentElement('afterend', box);
    el.suggestionsBox = box;
  }
  return el.suggestionsBox;
}

/* ---------- File uploads ---------- */
el.resumeFile?.addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  el.resumeText.value = await readAnyText(f);
});
el.jdFile?.addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  el.jdText.value = await readAnyText(f);
});
async function readAnyText(file) {
  if (file.name.endsWith('.docx')) return await readDocxAsText(file);
  return await readTextFile(file);
}

/* ---------- Analyze ---------- */
el.analyzeBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Add both resume + JD.');

  setStatus('Analyzing…');
  el.scoreBox.innerHTML = '';
  hideDiff();
  ensureSuggestionsBox().innerHTML = '';

  try {
    const data = await callFn('analyze', { resume, jd });
    renderCompactScore(el.scoreBox, data);
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Rewrite: single pass; show missing skills if <95 ---------- */
el.rewriteBtn.addEventListener('click', async () => {
  const jd = el.jdText.value.trim();
  const resume = el.resumeText.value.trim();
  if (!resume || !jd) return setRewriteStatus('Add both resume + JD.');

  lastOriginal = resume;
  lastRewritten = '';
  el.rewritten.innerHTML = '';
  el.rewriteScoreBox.innerHTML = '';
  hideDiff();
  ensureSuggestionsBox().innerHTML = '';

  setRewriteStatus('Rewriting…');
  try {
    const data = await callFn('rewrite', { resume, jd });
    lastRewritten = String(data?.rewritten_resume || resume);

    // Highlight missing keywords inline if they accidentally appear (weak match); otherwise, nothing to highlight
    const missing = Array.isArray(data?.missing_keywords) ? data.missing_keywords : [];
    el.rewritten.innerHTML = highlightKeywords(lastRewritten, missing, 'kw-missing-inline');

    const score = Math.round(Number(data?.final_score ?? 0));
    renderCompactScore(el.rewriteScoreBox, { match_score: score });
    setRewriteStatus('Done (single pass).');

    if (score < 95) {
      renderSuggestions(ensureSuggestionsBox(), score, missing, data?.suggested_skills_section);
    } else {
      ensureSuggestionsBox().innerHTML = '';
    }

    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed.';
  } catch (err) {
    console.error(err);
    setRewriteStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Show / hide changes ---------- */
el.showDiffBtn?.addEventListener('click', () => {
  const base = lastOriginal || el.resumeText.value.trim();
  const revised = lastRewritten || stripHtml(el.rewritten.innerHTML);
  if (!base || !revised) return setStatus('No baseline to compare.');

  if (el.diffBox.classList.contains('hidden')) {
    const html = renderDiffHtml(base, revised);
    el.diffBox.innerHTML = html;
    el.diffBox.classList.remove('hidden');
    el.diffBox.style.display = 'block';
    el.showDiffBtn.textContent = 'Hide changes';
  } else {
    hideDiff();
  }
});
function hideDiff() {
  el.diffBox.classList.add('hidden');
  el.diffBox.innerHTML = '';
  el.diffBox.style.display = '';
  if (el.showDiffBtn) el.showDiffBtn.textContent = 'Show changes';
}

/* ---------- Copy / Download ---------- */
el.copyBtn?.addEventListener('click', async () => {
  const text = el.rewritten.innerText || '';
  if (!text.trim()) return setStatus('Nothing to copy.');
  try { await navigator.clipboard.writeText(text); setStatus('Copied.'); }
  catch { setStatus('Copy failed.'); }
});
el.downloadBtn?.addEventListener('click', () => {
  const text = el.rewritten.innerText || '';
  if (!text.trim()) return setStatus('Nothing to download.');
  downloadText('rewritten-resume.txt', text);
});

/* ---------- Helpers ---------- */
async function callFn(action, payload) {
  const res = await fetch('/.netlify/functions/tailor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return {}; }
}
function renderCompactScore(target, data) {
  const score = Math.round(Number(data?.match_score ?? 0));
  target.innerHTML = `<span class="font-medium">New match score:</span> <span class="font-semibold">${score}</span>/100`;
}
function setStatus(m) { if (el.status) el.status.textContent = m || ''; }
function setRewriteStatus(m) { if (el.rewriteStatus) el.rewriteStatus.textContent = m || ''; }
function stripHtml(s) { const d = document.createElement('div'); d.innerHTML = s || ''; return d.innerText; }
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---------- Diff utilities (word-level LCS) ---------- */
function tokenize(str){ const out=[]; const re=/(\s+|[^\s]+)/g; let m; while((m=re.exec(str))!==null) out.push(m[0]); return out; }
function lcs(a,b){ const n=a.length,m=b.length; const dp=Array.from({length:n+1},()=>Array(m+1).fill(0)); for(let i=n-1;i>=0;i--){ for(let j=m-1;j>=0;j--){ dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]); } } const seq=[]; let i=0,j=0; while(i<n&&j<m){ if(a[i]===b[j]){ seq.push(a[i]); i++; j++; } else if(dp[i+1][j]>=dp[i][j+1]) i++; else j++; } return seq; }
function renderDiffHtml(original, rewritten){
  const a=tokenize(original), b=tokenize(rewritten), common=lcs(a,b);
  let i=0,j=0,k=0,out='';
  while(i<a.length||j<b.length){
    const next=common[k];
    let delBuf=''; while(i<a.length&&a[i]!==next){ delBuf+=a[i++]; }
    if(delBuf) out+=`<del>${escapeHtml(delBuf)}</del>`;
    let addBuf=''; while(j<b.length&&b[j]!==next){ addBuf+=b[j++]; }
    if(addBuf) out+=`<ins>${escapeHtml(addBuf)}</ins>`;
    if(k<common.length){ out+=escapeHtml(common[k]); i++; j++; k++; }
  }
  return out || escapeHtml(rewritten);
}

/* ---------- Missing keyword helpers ---------- */
function regexEscape(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlightKeywords(text, keywords, cls){
  if (!Array.isArray(keywords) || keywords.length === 0) return escapeHtml(text);
  // Sort by length desc to avoid nested highlights
  const sorted = [...new Set(keywords.map(k => String(k).trim()).filter(Boolean))].sort((a,b)=>b.length-a.length);
  let html = escapeHtml(text);
  for (const kw of sorted){
    const re = new RegExp(`\\b${regexEscape(kw)}\\b`, 'gi');
    html = html.replace(re, m => `<span class="${cls}">${m}</span>`);
  }
  return html;
}
function renderSuggestions(target, score, missingKeywords, suggestedBlock){
  const chips = (missingKeywords||[]).map(k => `<span class="kw-missing-chip">${escapeHtml(k)}</span>`).join(' ');
  const block = suggestedBlock ? `<pre style="white-space:pre-wrap;margin:8px 0 0 0;">${escapeHtml(suggestedBlock)}</pre>` : '';
  target.innerHTML = `
    <h4>Your match score is ${score}%. To reach 95%, consider adding these missing keywords:</h4>
    <div>${chips || '<em>No specific keywords suggested.</em>'}</div>
    ${block ? '<h4 style="margin-top:10px;">Suggested “Skills & Tools Match” block:</h4>' + block : ''}
  `;
}
