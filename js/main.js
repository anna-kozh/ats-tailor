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
  chips: document.getElementById('chips'),
  flags: document.getElementById('flags'),
  suggested: document.getElementById('suggested'),
  rewritten: document.getElementById('rewritten'),
  copyBtn: document.getElementById('copyBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  showDiffBtn: document.getElementById('showDiffBtn'),
  diffBox: document.getElementById('diffBox'),
  diffHint: document.getElementById('diffHint'),
  // NEW
  rewriteStatus: document.getElementById('rewriteStatus'),
  rewriteScoreBox: document.getElementById('rewriteScoreBox'),
};

let lastOriginal = '';
let lastRewritten = '';

/* ---------- File uploads ---------- */
el.resumeFile?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  el.resumeText.value = await readAnyText(file);
});

el.jdFile?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  el.jdText.value = await readAnyText(file);
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

  // Reset ONLY analyze panel
  el.scoreBox.innerHTML = '';
  el.chips.innerHTML = '';
  el.flags.textContent = '';
  hideDiff();

  setStatus('Analyzing…');
  try {
    const data = await callFn('analyze', { resume, jd });
    renderAnalysisTo(el.scoreBox, el.chips, el.flags, data);
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Rewrite ---------- */
el.rewriteBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setRewriteStatus('Add both resume + JD.');

  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'conservative';

  // Clear only the Tailored area; DO NOT touch Analysis panel
  el.rewritten.innerHTML = '';
  el.rewriteScoreBox.innerHTML = '';
  setRewriteStatus('Rewriting…');
  hideDiff();

  try {
    const data = await callFn('rewrite', { resume, jd, mode });

    renderSuggestions(data.suggestions || []);

    lastOriginal = resume;
    lastRewritten = data.rewritten_resume || '';

    if (lastRewritten) {
      const bolded = renderInlineBoldAdds(lastOriginal, lastRewritten);
      el.rewritten.innerHTML = bolded;
      // update textarea so next iteration compares from this version
      el.resumeText.value = lastRewritten;
    }

    // Immediately re-score but show the status/score NEXT TO "Updated Resume"
    setRewriteStatus('Re-scoring…');
    if (lastRewritten) {
      const scored = await callFn('analyze', { resume: lastRewritten, jd });
      renderCompactScore(el.rewriteScoreBox, scored);
    }
    setRewriteStatus('');
  } catch (err) {
    console.error(err);
    setRewriteStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Show changes toggle ---------- */
el.showDiffBtn.addEventListener('click', () => {
  const base = lastOriginal || el.resumeText.value.trim();
  const revised = lastRewritten || stripHtml(el.rewritten.innerHTML);
  if (!base || !revised) return setRewriteStatus('No baseline to compare.');

  if (el.diffBox.classList.contains('hidden')) {
    el.diffBox.innerHTML = renderDiffHtml(base, revised);
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

/* ---------- Copy / Download ---------- */
el.copyBtn.addEventListener('click', async () => {
  const text = el.rewritten.innerText || '';
  if (!text.trim()) return setRewriteStatus('Nothing to copy.');
  try {
    await navigator.clipboard.writeText(text);
    setRewriteStatus('Copied.');
  } catch {
    setRewriteStatus('Copy failed.');
  }
});

el.downloadBtn.addEventListener('click', () => {
  const text = el.rewritten.innerText || '';
  if (!text.trim()) return setRewriteStatus('Nothing to download.');
  downloadText('rewritten-resume.txt', text);
});

/* ---------- Netlify function wrapper ---------- */
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
  return res.json();
}

/* ---------- Render helpers ---------- */
function renderAnalysisTo(scoreBoxEl, chipsEl, flagsEl, data) {
  const capText = data.capped_reason ? ` (capped: ${escapeHtml(data.capped_reason)})` : '';
  const score = Math.round(Number(data.match_score || 0));
  scoreBoxEl.innerHTML = `<div class="text-base">Match score: <span class="font-semibold">${score}</span>/100${capText}</div>`;

  if (chipsEl) {
    const chips = [];
    for (const t of data.missing_required || []) chips.push(`<span class="chip">${escapeHtml(t)}</span>`);
    for (const t of data.missing_nice || []) chips.push(`<span class="chip">${escapeHtml(t)}</span>`);
    chipsEl.innerHTML = chips.join(' ') || '<span class="text-xs text-gray-500">No gaps flagged.</span>';
  }
  if (flagsEl) flagsEl.textContent = (data.flags || []).join(' · ') || '';
}

function renderCompactScore(target, data) {
  const score = Math.round(Number(data.match_score || 0));
  const cap = data.capped_reason ? ` <span class="text-xs text-gray-500">(capped: ${escapeHtml(data.capped_reason)})</span>` : '';
  target.innerHTML = `<span class="font-medium">New match score:</span> <span class="font-semibold">${score}</span>/100${cap}`;
}

function renderSuggestions(list) {
  el.suggested.innerHTML = '';
  (list || []).forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    el.suggested.appendChild(li);
  });
}

function setStatus(m) { el.status.textContent = m || ''; }
function setRewriteStatus(m) { el.rewriteStatus.textContent = m || ''; }

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function stripHtml(s) {
  const d = document.createElement('div');
  d.innerHTML = s || '';
  return d.innerText;
}

/* ---------- Diff utilities ---------- */
function renderInlineBoldAdds(original, rewritten) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, rewritten);
  dmp.diff_cleanupSemantic(diffs);

  const out = [];
  for (const [op, text] of diffs) {
    if (op === 1) out.push('<strong>' + escapeHtml(text) + '</strong>');
    else if (op === 0) out.push(escapeHtml(text));
  }
  return out.join('');
}

function renderDiffHtml(original, rewritten) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, rewritten);
  dmp.diff_cleanupSemantic(diffs);

  const frag = [];
  for (const [op, text] of diffs) {
    if (op === -1) frag.push('<del>' + escapeHtml(text) + '</del>');
    else if (op === 1) frag.push('<ins>' + escapeHtml(text) + '</ins>');
    else frag.push('<span>' + escapeHtml(text) + '</span>');
  }
  return frag.join('');
}
