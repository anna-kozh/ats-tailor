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

  // Clear previous score + chips + diff
  el.scoreBox.innerHTML = '';
  el.chips.innerHTML = '';
  el.flags.textContent = '';
  hideDiff();

  setStatus('Analyzing…');
  try {
    const res = await fetch('/.netlify/functions/tailor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'analyze', resume, jd }),
    });
    const data = await res.json();
    renderAnalysis(data);
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
  if (!resume || !jd) return setStatus('Add both resume + JD.');

  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'conservative';

  // Clear rewritten box + hide diff
  el.rewritten.innerHTML = '';
  hideDiff();

  setStatus('Rewriting…');
  try {
    const res = await fetch('/.netlify/functions/tailor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rewrite', resume, jd, mode }),
    });
    const data = await res.json();

    // Suggestions
    renderSuggestions(data.suggestions || data.bullet_suggestions || []);

    // Save originals for diff/highlights
    lastOriginal = resume;
    lastRewritten = data.rewritten_resume || '';

    // Inline: bold new content in the rewritten view
    if (lastRewritten) {
      const bolded = renderInlineBoldAdds(lastOriginal, lastRewritten);
      el.rewritten.innerHTML = bolded;
    }

    // Hint for the toggle diff
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed. Toggle to view.';

    // Auto re-score the rewritten resume (shows new score in Analysis)
    if (lastRewritten) {
      await refreshScore(lastRewritten, jd);
    }

    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + (err.message || 'unknown'));
  }
});

/* ---------- Show changes toggle ---------- */
el.showDiffBtn.addEventListener('click', () => {
  if (!lastOriginal && !el.resumeText.value.trim()) {
    return setStatus('No baseline to compare.');
  }
  // If user analyzed but didn’t rewrite, compare typed resume vs current rewritten view content (fallback)
  const base = lastOriginal || el.resumeText.value.trim();
  const revised = lastRewritten || stripHtml(el.rewritten.innerHTML);

  if (el.diffBox.classList.contains('hidden')) {
    // Generate and show diff
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
  if (!text.trim()) return setStatus('Nothing to copy.');
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied.');
  } catch {
    setStatus('Copy failed.');
  }
});

el.downloadBtn.addEventListener('click', () => {
  const text = el.rewritten.innerText || '';
  if (!text.trim()) return setStatus('Nothing to download.');
  downloadText('rewritten-resume.txt', text);
});

/* ---------- Refresh score (analyze rewritten) ---------- */
async function refreshScore(updatedResume, jd) {
  try {
    setStatus('Re-scoring…');
    const res = await fetch('/.netlify/functions/tailor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'analyze', resume: updatedResume, jd }),
    });
    const data = await res.json();
    renderAnalysis(data); // updates match score / missing items
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error scoring new resume');
  }
}

/* ---------- Render helpers ---------- */
function renderAnalysis(data) {
  const capText = data.capped_reason ? ` (capped: ${data.capped_reason})` : '';
  el.scoreBox.innerHTML = `<div class="text-base">Match score: <span class="font-semibold">${Math.round(data.match_score || 0)}</span>/100${capText}</div>`;

  const chips = [];
  for (const t of data.missing_required || []) chips.push(`<span class="chip">${escapeHtml(t)}</span>`);
  for (const t of data.missing_nice || []) chips.push(`<span class="chip">${escapeHtml(t)}</span>`);
  el.chips.innerHTML = chips.join(' ');

  el.flags.textContent = (data.flags || []).join(' · ');
  renderSuggestions(data.bullet_suggestions || []);
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
// Inline bold adds: only show rewritten text, with <strong> around added tokens.
function renderInlineBoldAdds(original, rewritten) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, rewritten);
  dmp.diff_cleanupSemantic(diffs);

  const out = [];
  for (const [op, text] of diffs) {
    if (op === 1) {
      out.push('<strong>' + escapeHtml(text) + '</strong>'); // added
    } else if (op === 0) {
      out.push(escapeHtml(text)); // unchanged
    }
    // deletions are omitted in inline view
  }
  return out.join('');
}

// Full diff view: show ins/del spans with color backgrounds.
function renderDiffHtml(original, rewritten) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, rewritten);
  dmp.diff_cleanupSemantic(diffs);

  const frag = [];
  for (const [op, text] of diffs) {
    if (op === -1) frag.push('<del>' + escapeHtml(text) + '</del>');      // removed (red)
    else if (op === 1) frag.push('<ins>' + escapeHtml(text) + '</ins>');  // added (green)
    else frag.push('<span>' + escapeHtml(text) + '</span>');
  }
  return frag.join('');
}
