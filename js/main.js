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

// ---------- Analyze ----------
el.analyzeBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Add both resume + JD.');

  // Clear previous score + chips
  el.scoreBox.innerHTML = '';
  el.chips.innerHTML = '';
  el.flags.textContent = '';

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

// ---------- Rewrite ----------
el.rewriteBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Add both resume + JD.');

  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'conservative';

  // Clear rewritten box + hide diff
  el.rewritten.value = '';
  el.diffBox.classList.add('hidden');
  el.showDiffBtn.textContent = 'Show changes';

  setStatus('Rewriting…');
  try {
    const res = await fetch('/.netlify/functions/tailor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rewrite', resume, jd, mode }),
    });
    const data = await res.json();

    // Fill rewritten + suggestions
    if (data.suggestions || data.bullet_suggestions) {
      renderSuggestions(data.suggestions || data.bullet_suggestions);
    }
    if (data.rewritten_resume) el.rewritten.value = data.rewritten_resume;

    // Prepare diff data
    lastOriginal = resume;
    lastRewritten = data.rewritten_resume || '';
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed. Toggle to view.';

    // Auto re-run score for rewritten version
    if (lastRewritten) {
      await refreshScore(lastRewritten, jd);
    }

    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + (err.message || 'unknown'));
  }
});

// ---------- Refresh score ----------
async function refreshScore(updatedResume, jd) {
  try {
    setStatus('Re-scoring…');
    const res = await fetch('/.netlify/functions/tailor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'analyze', resume: updatedResume, jd }),
    });
    const data = await res.json();
    renderAnalysis(data);
    setStatus('Done.');
  } catch (err) {
    console.error(err);
    setStatus('Error scoring new resume');
  }
}

// ---------- Render helpers ----------
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

function setStatus(m) {
  el.status.textContent = m || '';
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
