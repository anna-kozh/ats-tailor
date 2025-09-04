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
  downloadBtn: document.getElementById('downloadBtn')
};

let lastOriginal = '';
let lastRewritten = '';
const TARGET = 95;
const MAX_PASSES = 3;

window._ats = { lastOriginal: '', lastRewritten: '' };

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

  try {
    const data = await callFn('analyze', { resume, jd });
    renderCompactScore(el.scoreBox, data);
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Rewrite: up to 3 passes client-side to hit ≥95 ---------- */
el.rewriteBtn.addEventListener('click', async () => {
  const jd = el.jdText.value.trim();
  let current = el.resumeText.value.trim();
  if (!current || !jd) return setRewriteStatus('Add both resume + JD.');

  lastOriginal = current;
  lastRewritten = '';
  window._ats = { lastOriginal, lastRewritten };

  el.rewritten.innerHTML = '';
  el.rewriteScoreBox.innerHTML = '';
  hideDiff();

  setRewriteStatus('Rewriting…');
  let score = 0;
  let i = 0;

  try {
    for (i = 1; i <= MAX_PASSES; i++) {
      setRewriteStatus(`Pass ${i}/${MAX_PASSES}…`);
      const data = await callFn('rewrite', { resume: current, jd });
      current = String(data?.rewritten_resume || current);
      score = Math.round(Number(data?.final_score ?? 0));

      // incremental preview with bold additions
      try {
        el.rewritten.innerHTML = renderInlineBoldAdds(lastOriginal, current);
      } catch {
        el.rewritten.textContent = current;
      }
      renderCompactScore(el.rewriteScoreBox, { match_score: score });

      if (score >= TARGET) break;
    }

    lastRewritten = current;
    window._ats = { lastOriginal, lastRewritten };
    setRewriteStatus(`Done in ${i} pass${i === 1 ? '' : 'es'} (target ${TARGET}).`);
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed.';
  } catch (err) {
    console.error(err);
    setRewriteStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Show / hide changes (green adds, red deletes) ---------- */
el.showDiffBtn.addEventListener('click', () => {
  const base = lastOriginal || el.resumeText.value.trim();
  const revised = lastRewritten || stripHtml(el.rewritten.innerHTML);
  if (!base || !revised) return setStatus('No baseline to compare.');

  if (el.diffBox.classList.contains('hidden')) {
    const html = renderDiffHtml(base, revised); // <ins> and <del>
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
  el.showDiffBtn.textContent = 'Show changes';
}

/* ---------- Copy / Download ---------- */
el.copyBtn.addEventListener('click', async () => {
  const text = el.rewritten.innerText || '';
  if (!text.trim()) return setStatus('Nothing to copy.');
  try { await navigator.clipboard.writeText(text); setStatus('Copied.'); }
  catch { setStatus('Copy failed.'); }
});
el.downloadBtn.addEventListener('click', () => {
  const text = el.rewritten.innerText || '';
  if (!text.trim()) return setStatus('Nothing to download.');
  downloadText('rewritten-resume.txt', text);
});

/* ---------- HTTP helper ---------- */
async function callFn(action, payload) {
  const res = await fetch('/.netlify/functions/tailor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return {}; }
}

/* ---------- UI helpers ---------- */
function renderCompactScore(target, data) {
  const score = Math.round(Number(data?.match_score ?? 0));
  target.innerHTML = `<span class="font-medium">New match score:</span> <span class="font-semibold">${score}</span>/100`;
}
function setStatus(m) { el.status.textContent = m || ''; }
function setRewriteStatus(m) { el.rewriteStatus.textContent = m || ''; }
function stripHtml(s) { const d = document.createElement('div'); d.innerHTML = s || ''; return d.innerText; }
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---------- Built-in word diff (no external libs) ---------- */
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
function renderInlineBoldAdds(original, rewritten){
  const a=tokenize(original), b=tokenize(rewritten), common=lcs(a,b);
  let i=0,j=0,k=0,out='';
  while(i<a.length||j<b.length){
    const next=common[k];
    while(i<a.length&&a[i]!==next){ i++; }
    let addBuf=''; while(j<b.length&&b[j]!==next){ addBuf+=b[j++]; }
    if(addBuf) out+=`<strong>${escapeHtml(addBuf)}</strong>`;
    if(k<common.length){ out+=escapeHtml(common[k]); i++; j++; k++; }
  }
  return out || escapeHtml(rewritten);
}
