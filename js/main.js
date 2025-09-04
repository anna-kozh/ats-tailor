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

/* ---------- Rewrite: loop client-side to hit ≥95 (max 3 passes) ---------- */
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

      // show incremental bold adds
      try {
        const html = renderInlineBoldAdds(lastOriginal, current);
        el.rewritten.innerHTML = html && html.trim() ? html : escapeHtml(current);
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
    try {
      const html = renderDiffHtml(base, revised);
      el.diffBox.innerHTML = html && html.trim() ? html : escapeHtml(revised);
    } catch (e) {
      console.warn('diff render failed; showing plain text', e);
      el.diffBox.textContent = revised;
    }
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

/* ---------- Shared helpers ---------- */
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
function setStatus(m) { el.status.textContent = m || ''; }
function setRewriteStatus(m) { el.rewriteStatus.textContent = m || ''; }
function stripHtml(s) { const d = document.createElement('div'); d.innerHTML = s || ''; return d.innerText; }
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---------- Diff utilities ---------- */
function ensureDmp() {
  return (typeof diff_match_patch === 'function') ? new diff_match_patch() : null;
}
function renderInlineBoldAdds(original, rewritten) {
  const dmp = ensureDmp();
  if (!dmp) return escapeHtml(String(rewritten ?? ''));
  const diffs = dmp.diff_main(String(original ?? ''), String(rewritten ?? ''));
  dmp.diff_cleanupSemantic(diffs);
  let out = '';
  for (const [op, text] of diffs) {
    if (op === 1) out += '<strong>' + escapeHtml(text) + '</strong>';
    else if (op === 0) out += escapeHtml(text);
  }
  return out || escapeHtml(String(rewritten ?? ''));
}
function renderDiffHtml(original, rewritten) {
  const dmp = ensureDmp();
  if (!dmp) return escapeHtml(String(rewritten ?? ''));
  const diffs = dmp.diff_main(String(original ?? ''), String(rewritten ?? ''));
  dmp.diff_cleanupSemantic(diffs);
  let out = '';
  for (const [op, text] of diffs) {
    if (op === -1) out += '<del>' + escapeHtml(text) + '</del>';
    else if (op === 1) out += '<ins>' + escapeHtml(text) + '</ins>';
    else out += '<span>' + escapeHtml(text) + '</span>';
  }
  return out || escapeHtml(String(rewritten ?? ''));
}
