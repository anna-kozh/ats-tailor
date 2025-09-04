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

// cache originals for diff
let lastOriginal = '';
let lastRewritten = '';

// ---------- file readers ----------
el.resumeFile.addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f) return;
  setStatus('Reading resume…');
  el.resumeText.value = f.name.endsWith('.docx') ? await readDocxAsText(f) : await readTextFile(f);
  setStatus('');
});
el.jdFile.addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f) return;
  setStatus('Reading JD…');
  el.jdText.value = f.name.endsWith('.docx') ? await readDocxAsText(f) : await readTextFile(f);
  setStatus('');
});

// ---------- analyze ----------
el.analyzeBtn.addEventListener('click', async ()=>{
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if(!resume || !jd){ return setStatus('Add both resume + JD.'); }
  setStatus('Analyzing…');
  try {
    const res = await fetch('/.netlify/functions/tailor', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'analyze', resume, jd })
    });
    const data = await res.json();
    renderAnalysis(data);
    setStatus('Done.');
  } catch(err){
    console.error(err); setStatus('Error: ' + (err.message||'unknown'));
  }
});

// ---------- rewrite ----------
el.rewriteBtn.addEventListener('click', async ()=>{
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if(!resume || !jd){ return setStatus('Add both resume + JD.'); }
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'conservative';
  setStatus('Rewriting…');
  try {
    const res = await fetch('/.netlify/functions/tailor', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'rewrite', resume, jd, mode })
    });
    const data = await res.json();

    // fill text + suggestions
    if (data.suggestions || data.bullet_suggestions) {
      renderSuggestions(data.suggestions || data.bullet_suggestions);
    }
    if (data.rewritten_resume) el.rewritten.value = data.rewritten_resume;

    // prepare diff data
    lastOriginal = resume;
    lastRewritten = data.rewritten_resume || '';
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed. Toggle to view.';

    // reset diff view if open
    if (!el.diffBox.classList.contains('hidden')) {
      el.diffBox.innerHTML = buildDiffHtml(lastOriginal, lastRewritten);
    }

    setStatus('Done.');
  } catch(err){
    console.error(err); setStatus('Error: ' + (err.message||'unknown'));
  }
});

// ---------- copy / download ----------
el.copyBtn?.addEventListener('click', async ()=>{
  await navigator.clipboard.writeText(el.rewritten.value || '');
  setStatus('Copied.');
});
el.downloadBtn?.addEventListener('click', ()=> downloadText('resume-tailored.txt', el.rewritten.value || ''));

// ---------- diff toggle ----------
el.showDiffBtn?.addEventListener('click', ()=>{
  if (el.diffBox.classList.contains('hidden')) {
    el.diffBox.innerHTML = buildDiffHtml(lastOriginal, lastRewritten);
    el.diffBox.classList.remove('hidden');
    el.showDiffBtn.textContent = 'Hide changes';
    if (el.diffHint) el.diffHint.textContent = 'Green = added, red = removed.';
  } else {
    el.diffBox.classList.add('hidden');
    el.showDiffBtn.textContent = 'Show changes';
  }
});

// ---------- render helpers ----------
function renderAnalysis(data){
  const capText = data.capped_reason ? ` (capped: ${data.capped_reason})` : '';
  el.scoreBox.innerHTML = `<div class="text-base">Match score: <span class="font-semibold">${Math.round(data.match_score||0)}</span>/100${capText}</div>`;

  const chips = [];
  for (const t of (data.missing_required||[])) chips.push(`<span class="chip">${escapeHtml(t)}</span>`);
  for (const t of (data.missing_nice||[])) chips.push(`<span class="chip">${escapeHtml(t)}</span>`);
  el.chips.innerHTML = chips.join(' ');

  el.flags.textContent = (data.flags||[]).join(' · ');

  renderSuggestions(data.bullet_suggestions || []);
}

function renderSuggestions(list){
  el.suggested.innerHTML = '';
  (list || []).forEach(s=>{
    const li = document.createElement('li');
    li.textContent = s;
    el.suggested.appendChild(li);
  });
}

function setStatus(m){ el.status.textContent = m || ''; }

// ---------- diff helpers ----------
function escapeHtml(s){
  return String(s || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function buildDiffHtml(a, b){
  const dmp = new diff_match_patch();
  // coarser, word-ish diffs
  dmp.Diff_EditCost = 6;
  const diffs = dmp.diff_main(a || '', b || '');
  dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text])=>{
    const t = escapeHtml(text);
    if (op === 0) return `<span>${t}</span>`; // unchanged
    if (op === 1) return `<ins>${t}</ins>`;   // added
    return `<del>${t}</del>`;                 // removed
  }).join('');
}
