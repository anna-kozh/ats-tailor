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
};

let lastOriginal = '';
let lastRewritten = '';

/* ---------- file uploads ---------- */
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

/* ---------- analyze ---------- */
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

/* ---------- rewrite ---------- */
el.rewriteBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setRewriteStatus('Add both resume + JD.');

  el.rewritten.innerHTML = '';
  el.rewriteScoreBox.innerHTML = '';
  hideDiff();

  setRewriteStatus('Rewriting…');
  try {
    const data = await callFn('rewrite', { resume, jd });

    // Bulletproof defaults
    lastOriginal = String(resume || '');
    const serverText = (data && typeof data.rewritten_resume === 'string') ? data.rewritten_resume : '';
    lastRewritten = serverText.trim() ? serverText : lastOriginal;

    // Diff view — wrap in try so UI never crashes
    try {
      el.rewritten.innerHTML = renderInlineBoldAdds(lastOriginal, lastRewritten);
    } catch (diffErr) {
      console.warn('Diff render failed, falling back to plain text:', diffErr);
      el.rewritten.textContent = lastRewritten;
    }

    // Use server score if present; otherwise re-score
    const serverScore = Number.isFinite(Number(data?.final_score)) ? Number(data.final_score) : null;
    if (serverScore !== null) {
      renderCompactScore(el.rewriteScoreBox, { match_score: serverScore });
    } else {
      const scored = await callFn('analyze', { resume: lastRewritten, jd });
      renderCompactScore(el.rewriteScoreBox, scored || { match_score: 0 });
    }

    // Update textarea with rewritten for further loops
    el.resumeText.value = lastRewritten;

    setRewriteStatus('Done.');
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed. Toggle to view.';
  } catch (err) {
    console.error(err);
    setRewriteStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- show/hide changes ---------- */
el.showDiffBtn.addEventListener('click', () => {
  const base = lastOriginal || el.resumeText.value.trim();
  const revised = lastRewritten || stripHtml(el.rewritten.innerHTML);
  if (!base || !revised) return setStatus('No baseline to compare.');

  if (el.diffBox.classList.contains('hidden')) {
    try {
      el.diffBox.innerHTML = renderDiffHtml(base, revised);
    } catch (err) {
      console.warn('Diff box render failed, showing plain text', err);
      el.diffBox.textContent = revised;
    }
    el.diffBox.classList.remove('hidden');
    el.showDiffBtn.textContent = 'Hide changes';
  } else {
    hideDiff();
  }
});
function hideDiff() {
  el.diffBox.classList.add('hidden');
  el.diffBox.innerHTML = '';
  el.showDiffBtn.textContent = 'Show changes';
}

/* ---------- copy / download ---------- */
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

/* ---------- helpers ---------- */
async function callFn(action, payload) {
  const res = await fetch('/.netlify/functions/tailor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  if (!res.ok) {
    // surface server error body
    const t = await res.text().catch(() => '');
    throw new Error(t || `HTTP ${res.status}`);
  }
  // also guard here – if server sends non-JSON, don’t blow up the UI
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

/* ---------- diff utils (defensive) ---------- */
function ensureDmp() {
  if (typeof diff_match_patch !== 'function') throw new Error('diff_match_patch not loaded');
  return new diff_match_patch();
}
function renderInlineBoldAdds(original, rewritten) {
  const dmp = ensureDmp();
  const diffs = dmp.diff_main(String(original ?? ''), String(rewritten ?? ''));
  dmp.diff_cleanupSemantic(diffs);
  // normalize to array of 2-item arrays
  const safe = Array.isArray(diffs) ? diffs : [];
  let out = '';
  for (let i = 0; i < safe.length; i++) {
    const item = safe[i];
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
  const safe = Array.isArray(diffs) ? diffs : [];
  let out = '';
  for (let i = 0; i < safe.length; i++) {
    const item = safe[i];
    const op = Array.isArray(item) ? item[0] : (item?.operation ?? item?.op ?? 0);
    const text = Array.isArray(item) ? item[1] : (item?.text ?? '');
    if (op === -1) out += '<del>' + escapeHtml(text) + '</del>';
    else if (op === 1) out += '<ins>' + escapeHtml(text) + '</ins>';
    else out += '<span>' + escapeHtml(text) + '</span>';
  }
  return out || escapeHtml(String(rewritten ?? ''));
}
