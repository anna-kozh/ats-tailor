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
  chips: document.getElementById('chips'),
  approveBtn: document.getElementById('approveBtn'),
  final: document.getElementById('final'),
  finalScoreBox: document.getElementById('finalScoreBox'),
  finalStatus: document.getElementById('finalStatus'),
  chipsFinal: document.getElementById('chipsFinal'),
  showDiffBtn: document.getElementById('showDiffBtn'),
  diffBox: document.getElementById('diffBox'),
  diffHint: document.getElementById('diffHint'),
  copyBtn: document.getElementById('copyBtn'),
  downloadBtn: document.getElementById('downloadBtn')
};

let v1 = '';       // original resume
let v2 = '';       // rewritten v2
let v3 = '';       // final v3
let missingV2 = []; // missing keywords after v2

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

/* ---------- Analyze (Step 2) ---------- */
el.analyzeBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Add both resume + JD.');

  setStatus('Analyzing…');
  el.scoreBox.innerHTML = '';
  try {
    const data = await callFn('analyze', { resume, jd });
    renderScore(el.scoreBox, data?.match_score);
    setStatus('');
  } catch (err) {
    setStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Rewrite to v2 (Step 3) ---------- */
el.rewriteBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setRewriteStatus('Add both resume + JD.');

  v1 = resume;
  v2 = '';
  v3 = '';
  el.rewritten.textContent = '';
  el.final.textContent = '';
  el.rewriteScoreBox.textContent = '';
  el.finalScoreBox.textContent = '';
  el.chips.innerHTML = '';
  el.chipsFinal.innerHTML = '';
  hideDiff();

  setRewriteStatus('Rewriting…');
  try {
    const data = await callFn('rewrite', { resume, jd });
    v2 = String(data?.rewritten_resume || resume);
    missingV2 = Array.isArray(data?.missing_keywords) ? data.missing_keywords : [];
    el.rewritten.textContent = v2;
    renderScore(el.rewriteScoreBox, data?.final_score);

    // Build chips
    el.chips.innerHTML = '';
    for (const kw of missingV2) addChip(kw, el.chips);

    setRewriteStatus('');
  } catch (err) {
    setRewriteStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Approve (Step 4) ---------- */
el.approveBtn.addEventListener('click', async () => {
  if (!v2) return setFinalStatus('Rewrite first.');
  const jd = el.jdText.value.trim();
  const approved = currentChips(el.chips);
  setFinalStatus('Improving to v3…');
  el.final.textContent = '';

  try {
    const data = await callFn('approve', { resume_v2: v2, jd, approved_keywords: approved });
    v3 = String(data?.final_resume || v2);
    el.final.textContent = v3;
    renderScore(el.finalScoreBox, data?.final_score);
    el.chipsFinal.innerHTML = '';
    for (const kw of (data?.missing_keywords_after || [])) addChip(kw, el.chipsFinal);

    // Update diff to compare v1 and v3
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed.';
  } catch (err) {
    setFinalStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Show / hide changes (v1 vs latest) ---------- */
el.showDiffBtn?.addEventListener('click', () => {
  const base = v1 || el.resumeText.value.trim();
  const revised = v3 || v2 || '';
  if (!base || !revised) return setStatus('No baseline to compare.');

  if (el.diffBox.classList.contains('hidden')) {
    el.diffBox.innerHTML = renderDiffHtml(base, revised);
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
  const text = el.final.innerText || '';
  if (!text.trim()) return setFinalStatus('Nothing to copy.');
  try { await navigator.clipboard.writeText(text); setFinalStatus('Copied.'); }
  catch { setFinalStatus('Copy failed.'); }
});
el.downloadBtn?.addEventListener('click', () => {
  const text = el.final.innerText || '';
  if (!text.trim()) return setFinalStatus('Nothing to download.');
  downloadText('resume-v3.txt', text);
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
function renderScore(target, score) {
  const s = Math.round(Number(score ?? 0));
  target.innerHTML = `<span class="font-medium">Score:</span> <span class="font-semibold">${s}</span>/100`;
}
function setStatus(m) { el.status.textContent = m || ''; }
function setRewriteStatus(m) { el.rewriteStatus.textContent = m || ''; }
function setFinalStatus(m) { el.finalStatus.textContent = m || ''; }

function addChip(text, container) {
  const chip = document.createElement('span');
  chip.className = 'kw-chip';
  chip.dataset.kw = text;
  chip.innerHTML = `<span>${escapeHtml(text)}</span><button aria-label="remove">×</button>`;
  chip.querySelector('button').addEventListener('click', () => chip.remove());
  container.appendChild(chip);
}
function currentChips(container) {
  return Array.from(container.querySelectorAll('[data-kw]')).map(el => el.dataset.kw);
}

function tokenize(str){ const out=[]; const re=/(\s+|[^\s]+)/g; let m; while((m=re.exec(str))!==null) out.push(m[0]); return out; }
function lcs(a,b){ const n=a.length,m=b.length; const dp=Array.from({length:n+1},()=>Array(m+1).fill(0)); for(let i=n-1;i>=0;i--){ for(let j=m-1;j>=0;j--){ dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]); } } const seq=[]; let i=0,j=0; while(i<n&&j<m){ if(a[i]===b[j]){ seq.push(a[i]); i++; j++; } else if(dp[i+1][j]>=dp[i][j+1]) i++; else j++; } return seq; }
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
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
