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
// debug mirror so we can introspect in console
window._ats = { lastOriginal: '', lastRewritten: '' };

/* ---------------- File uploads ---------------- */
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

/* ---------------- Analyze ---------------- */
el.analyzeBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Add both resume + JD.');

  setStatus('Analyzing…');
  el.scoreBox.innerHTML = '';
  hideDiff();

  try {
    const data = await callFn('analyze', { resume, jd });
    const score = Math.round(Number(data?.match_score ?? 0));
    el.scoreBox.innerHTML = `<div class="text-base">Match score: <span class="font-semibold">${score}</span>/100</div>`;
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------------- Rewrite ---------------- */
el.rewriteBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setRewriteStatus('Add both resume + JD.');

  // capture original immediately so Show changes works even if request fails
  lastOriginal = String(resume || '');
  lastRewritten = ''; // will fill after response
  window._ats = { lastOriginal, lastRewritten };

  el.rewritten.innerHTML = '';
  el.rewriteScoreBox.innerHTML = '';
  hideDiff();

  setRewriteStatus('Rewriting…');
  try {
    const data = await callFn('rewrite', { resume, jd });

    const serverText = (data && typeof data.rewritten_resume === 'string') ? data.rewritten_resume : '';
    lastRewritten = (serverText && serverText.trim()) ? serverText : lastOriginal;
    window._ats = { lastOriginal, lastRewritten };

    // render inline bold adds; never crash
    try {
      const html = renderInlineBoldAdds(lastOriginal, lastRewritten);
      el.rewritten.innerHTML = html || escapeHtml(lastRewritten);
    } catch (e) {
      console.warn('inline diff failed; fallback to text', e);
      el.rewritten.textContent = lastRewritten;
    }

    // prefer server score; otherwise rescore
    const serverScore = Number.isFinite(Number(data?.final_score)) ? Number(data.final_score) : null;
    if (serverScore !== null) {
      renderCompactScore(el.rewriteScoreBox, { match_score: serverScore });
    } else {
      const scored = await callFn('analyze', { resume: lastRewritten, jd });
      renderCompactScore(el.rewriteScoreBox, scored || { match_score: 0 });
    }

    // IMPORTANT: do NOT overwrite original textarea
    // el.resumeText.value = lastRewritten;

    setRewriteStatus('Done.');
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed. Toggle to view.';
  } catch (err) {
    console.error(err);
    setRewriteStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------------- Show / hide changes ---------------- */
el.showDiffBtn.addEventListener('click', () => {
  const base = lastOriginal || el.resumeText.value.trim();
  const revised = lastRewritten || stripHtml(el.rewritten.innerHTML);
  if (!base || !revised) return setStatus('No baseline to compare.');

  if (el.diffBox.classList.contains('hidden')) {
    try {
      const html = renderDiffHtml(base, revised);
      // fallback to plain text if diff lib returns empty/whitespace
      el.diffBox.innerHTML = html && html.trim() ? html : escapeHtml(revised);
    } catch (e) {
      console.warn('diff render failed; showing plain text', e);
      el.diffBox.textContent = revised;
    }
    el.diffBox.classList.remove('hidden');
    el.diffBox.style.display = 'block'; // extra guard
    el.showDiffBtn.textContent = 'Hide changes';
  } else {
    hideDiff();
  }
});
function hideDiff() {
  el.diffBox.classList.add('hidden');
  el.diffBox.innerHTML = '';
  el.diffBox.style.display = ''; // reset
  el.showDiffBtn.textContent = 'Show changes';
}

/* ---------------- Copy / Download ---------------- */
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

/* ---------------- Helpers ---------------- */
async function callFn(action, payload) {
  const res = await fetch('/.netlify/functions/tailor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(t || `HTTP ${res.status}`);
  }
  try { return await res.json(); } catch { return {}; } // never crash on bad JSON
}
function renderCompactScore(target, data) {
  const score = Math.round(Number(data?.match_score ?? 0));
  target.innerHTML = `<span class="font-medium">New match score:</span> <span class="font-semibold">${score}</span>/100`;
}
function setStatus(m) { el.status.textContent = m || ''; }
function setRewriteStatus(m) { el.rewriteStatus.textContent = m || ''; }
function stripHtml(s) { const d = document.createElement('div'); d.innerHTML = s || ''; return d.innerText; }
function escapeHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ---------------- Diff utilities (defensive) ---------------- */
function ensureDmp() {
  if (typeof diff_match_patch !== 'function') throw new Error('diff_match_patch not loaded');
  return new diff_match_patch();
}
function renderInlineBoldAdds(original, rewritten) {
  const dmp = ensureDmp();
  const diffs = dmp.diff_main(String(original ?? ''), String(rewritten ?? ''));
  dmp.diff_cleanupSemantic(diffs);

  if (!Array.isArray(diffs)) return escapeHtml(String(rewritten ?? ''));
  let out = '';
  for (let i = 0; i < diffs.length; i++) {
    const item = diffs[i];
    const op = Array.isArray(item) ? item[0] : (item?.operation ?? item?.op ?? 0);
    const text = Array.isArray(item) ? item[1] : (item?.text ?? '');
    if (op === 1) out += '<strong>' + escapeHtml(text) + '</strong>';
    else if (op === 0) out += escapeHtml(text);
  }
  return out || escapeHtml(String(rewritten ?? ''));
}
function renderDiffHtml(original, rewritten) {
  const dmp = ensureDmp();
  const diffs = dmp.diff_main(String(original ?? ''), String(rewritten ?? ''));
  dmp.diff_cleanupSemantic(diffs);

  if (!Array.isArray(diffs)) return escapeHtml(String(rewritten ?? ''));
  let out = '';
  for (let i = 0; i < diffs.length; i++) {
    const item = diffs[i];
    const op = Array.isArray(item) ? item[0] : (item?.operation ?? item?.op ?? 0);
    const text = Array.isArray(item) ? item[1] : (item?.text ?? '');
    if (op === -1) out += '<del>' + escapeHtml(text) + '</del>';
    else if (op === 1) out += '<ins>' + escapeHtml(text) + '</ins>';
    else out += '<span>' + escapeHtml(text) + '</span>';
  }
  return out || escapeHtml(String(rewritten ?? ''));
}
