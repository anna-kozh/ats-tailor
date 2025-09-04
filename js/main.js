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

/* ---------- Rewrite: ONE PASS ---------- */
el.rewriteBtn.addEventListener('click', async () => {
  const jd = el.jdText.value.trim();
  const resume = el.resumeText.value.trim();
  if (!resume || !jd) return setRewriteStatus('Add both resume + JD.');

  lastOriginal = resume;
  lastRewritten = '';
  el.rewritten.innerHTML = '';
  el.rewriteScoreBox.innerHTML = '';
  hideDiff();

  setRewriteStatus('Rewriting…');
  try {
    const data = await callFn('rewrite', { resume, jd });
    lastRewritten = String(data?.rewritten_resume || resume);

    // Show rewritten with bold additions relative to original
    el.rewritten.innerHTML = renderInlineBoldAdds(lastOriginal, lastRewritten);

    const score = Math.round(Number(data?.final_score ?? 0));
    renderCompactScore(el.rewriteScoreBox, { match_score: score });
    setRewriteStatus('Done (single pass).');
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
    const html = renderDiffHtml(base, revised); // uses <ins> and <del>
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
// Tokenize by words + whitespace to keep spacing intact
function tokenize(str) {
  const tokens = [];
  const regex = /(\s+|[^\s]+)/g;
  let m;
  while ((m = regex.exec(str)) !== null) tokens.push(m[0]);
  return tokens;
}
// LCS to find unchanged tokens
function lcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const seq = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { seq.push(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return seq;
}
function renderDiffHtml(original, rewritten) {
  const a = tokenize(original), b = tokenize(rewritten);
  const common = lcs(a, b);
  let i = 0, j = 0, k = 0, out = '';
  while (i < a.length || j < b.length) {
    const nextCommon = common[k];
    // deletions from a until nextCommon
    let delBuf = '';
    while (i < a.length && a[i] !== nextCommon) { delBuf += a[i++]; }
    if (delBuf) out += `<del>${escapeHtml(delBuf)}</del>`;
    // additions from b until nextCommon
    let addBuf = '';
    while (j < b.length && b[j] !== nextCommon) { addBuf += b[j++]; }
    if (addBuf) out += `<ins>${escapeHtml(addBuf)}</ins>`;
    // unchanged token
    if (k < common.length) { out += escapeHtml(common[k]); i++; j++; k++; }
  }
  return out || escapeHtml(rewritten);
}
// For the live rewritten preview: make additions bold
function renderInlineBoldAdds(original, rewritten) {
  const a = tokenize(original), b = tokenize(rewritten);
  const common = lcs(a, b);
  let i = 0, j = 0, k = 0, out = '';
  while (i < a.length || j < b.length) {
    const nextCommon = common[k];
    // skip deletions
    while (i < a.length && a[i] !== nextCommon) { i++; }
    // additions get bold
    let addBuf = '';
    while (j < b.length && b[j] !== nextCommon) { addBuf += b[j++]; }
    if (addBuf) out += `<strong>${escapeHtml(addBuf)}</strong>`;
    if (k < common.length) { out += escapeHtml(common[k]); i++; j++; k++; }
  }
  return out || escapeHtml(rewritten);
}
