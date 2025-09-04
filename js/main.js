import { readDocxAsText, readTextFile, downloadText } from './utils.js';
import { initModels, extractJD, generateRewrite } from './llm.js?v=8';


import { scoreResume } from './scoring.js';

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
  const f=e.target.files[0]; if(!f) return;
  setStatus('Reading resume…');
  el.resumeText.value = f.name.endsWith('.docx') ? await readDocxAsText(f) : await readTextFile(f);
  setStatus('');
});
el.jdFile.addEventListener('change', async (e)=>{
  const f=e.target.files[0]; if(!f) return;
  setStatus('Reading JD…');
  el.jdText.value = f.name.endsWith('.docx') ? await readDocxAsText(f) : await readTextFile(f);
  setStatus('');
});

el.analyzeBtn.addEventListener('click', async ()=>{
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if(!resume || !jd) return setStatus('Add both resume + JD.');

  setStatus('Loading small local models (first run downloads weights)…');
  await initModels();
  setStatus('Extracting requirements…');
  const jdInfo = await extractJD(jd);
  setStatus('Scoring…');
  const res = await scoreResume(resume, jd, jdInfo);
  renderAnalysis(res, jdInfo);
  setStatus('Done.');
});

el.rewriteBtn.addEventListener('click', async ()=>{
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if(!resume || !jd) return setStatus('Add both resume + JD.');
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'conservative';

  setStatus('Generating tailored draft…');
  await initModels();
  const jdInfo = await extractJD(jd);
  const res = await scoreResume(resume, jd, jdInfo);
  const gen = await generateRewrite(resume, jd, jdInfo, res, mode);
  el.rewritten.value = gen.rewritten || '';
  renderSuggestions(gen.suggestions || []);
  setStatus('Done.');
});

el.copyBtn?.addEventListener('click', async ()=>{
  await navigator.clipboard.writeText(el.rewritten.value || '');
  setStatus('Copied.');
});
el.downloadBtn?.addEventListener('click', ()=> downloadText('resume-tailored.txt', el.rewritten.value || ''));

function renderAnalysis(res, jdInfo){
  const cap = res.cap_reason ? ` (capped: ${res.cap_reason})` : '';
  el.scoreBox.innerHTML = `<div class="text-base">Match score: <span class="font-semibold">${Math.round(res.total)}</span>/100${cap}</div>`;
  const chips=[];
  for(const t of jdInfo.must_have||[]) chips.push(`<span class='chip ${res.coverage.exact.has(t)?'border-green-600 text-green-700':''}'>${t}</span>`);
  for(const t of jdInfo.nice||[]) chips.push(`<span class='chip ${res.coverage.exact.has(t)?'border-green-600 text-green-700':''}'>${t}</span>`);
  el.chips.innerHTML = chips.join(' ');
  el.flags.textContent = (res.flags||[]).join(' · ');
}
function renderSuggestions(list){
  el.suggested.innerHTML='';
  for(const s of list){
    const li=document.createElement('li');
    li.textContent=s;
    el.suggested.appendChild(li);
  }
}
function setStatus(m){ el.status.textContent = m || ''; }
