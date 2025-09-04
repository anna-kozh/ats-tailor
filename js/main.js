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
  downloadBtn: document.getElementById('downloadBtn')
};

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
    if (data.suggestions) renderSuggestions(data.suggestions);
    if (data.rewritten_resume) el.rewritten.value = data.rewritten_resume;
    setStatus('Done.');
  } catch(err){
    console.error(err); setStatus('Error: ' + (err.message||'unknown'));
  }
});

el.copyBtn?.addEventListener('click', async ()=>{
  await navigator.clipboard.writeText(el.rewritten.value || '');
  setStatus('Copied.');
});
el.downloadBtn?.addEventListener('click', ()=> downloadText('resume-tailored.txt', el.rewritten.value || ''));

function renderAnalysis(data){
  const cap = data.capped_reason ? ` (capped: ${data.capped_reason})` : '';
  el.scoreBox.innerHTML = `<div class="text-base">Match score: <span class="font-semibold">${Math.round(data.match_score||0)}</span>/100${cap}</div>`;

  const chips = [];
  for (const t of (data.missing_required||[])) chips.push(`<span class="chip">${t}</span>`);
  for (const t of (data.missing_nice||[])) chips.push(`<span class="chip">${t}</span>`);
  el.chips.innerHTML = chips.join(' ');

  el.flags.textContent = (data.flags||[]).join(' · ');

  renderSuggestions(data.bullet_suggestions || []);
}

function renderSuggestions(list){
  el.suggested.innerHTML = '';
  for (const s of list){
    const li = document.createElement('li');
    li.textContent = s;
    el.suggested.appendChild(li);
  }
}

function setStatus(m){ el.status.textContent = m || ''; }
