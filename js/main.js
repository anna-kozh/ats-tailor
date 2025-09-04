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

// Upload handlers
el.resumeFile?.addEventListener('change', async e => {
  const f = e.target.files?.[0]; if(!f) return;
  el.resumeText.value = await readAnyText(f);
});
el.jdFile?.addEventListener('change', async e => {
  const f = e.target.files?.[0]; if(!f) return;
  el.jdText.value = await readAnyText(f);
});
async function readAnyText(file){
  if(file.name.endsWith('.docx')) return await readDocxAsText(file);
  return await readTextFile(file);
}

// Analyze
el.analyzeBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Add both resume + JD.');
  setStatus('Analyzing…'); el.scoreBox.innerHTML=''; hideDiff();
  try {
    const data = await callFn('analyze', { resume, jd });
    const score = Math.round(Number(data.match_score||0));
    el.scoreBox.innerHTML = `<div class="text-base">Match score: <span class="font-semibold">${score}</span>/100</div>`;
    setStatus('Done.');
  } catch (err) {
    console.error(err); setStatus('Error: '+(err.message||'unknown'));
  }
});

// Rewrite
el.rewriteBtn.addEventListener('click', async () => {
  const resume = el.resumeText.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setRewriteStatus('Add both resume + JD.');
  el.rewritten.innerHTML = ''; el.rewriteScoreBox.innerHTML=''; hideDiff();
  setRewriteStatus('Rewriting…');
  try {
    const data = await callFn('rewrite', { resume, jd });
    lastOriginal = resume || '';
    lastRewritten = typeof data.rewritten_resume === 'string' && data.rewritten_resume.trim() ? data.rewritten_resume : resume;
    const bolded = renderInlineBoldAdds(lastOriginal, lastRewritten);
    el.rewritten.innerHTML = bolded || escapeHtml(lastRewritten);
    el.resumeText.value = lastRewritten;
    const score = Math.round(Number(data.final_score||0));
    el.rewriteScoreBox.innerHTML = `<span class="font-medium">New match score:</span> <span class="font-semibold">${score}</span>/100`;
    setRewriteStatus('Done.');
    el.diffHint.textContent = 'Green = added, red = removed. Toggle to view.';
  } catch (err) {
    console.error(err); setRewriteStatus('Error: '+(err.message||'unknown'));
  }
});

// Diff toggle
el.showDiffBtn.addEventListener('click', () => {
  const base = lastOriginal || el.resumeText.value.trim();
  const revised = lastRewritten || stripHtml(el.rewritten.innerHTML);
  if (!base || !revised) return setStatus('No baseline to compare.');
  if (el.diffBox.classList.contains('hidden')) {
    el.diffBox.innerHTML = renderDiffHtml(base, revised);
    el.diffBox.classList.remove('hidden');
    el.showDiffBtn.textContent = 'Hide changes';
  } else {
    hideDiff();
  }
});
function hideDiff(){ el.diffBox.classList.add('hidden'); el.diffBox.innerHTML=''; el.showDiffBtn.textContent='Show changes'; }

// Copy/Download
el.copyBtn.addEventListener('click', async () => {
  const t = el.rewritten.innerText||''; if(!t.trim()) return setStatus('Nothing to copy.');
  await navigator.clipboard.writeText(t).catch(()=>{}); setStatus('Copied.');
});
el.downloadBtn.addEventListener('click', ()=>{
  const t = el.rewritten.innerText||''; if(!t.trim()) return setStatus('Nothing to download.');
  downloadText('rewritten-resume.txt', t);
});

// Helpers
async function callFn(action, payload){
  const res = await fetch('/.netlify/functions/tailor', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action, ...payload })
  });
  if(!res.ok){ throw new Error(await res.text().catch(()=>`HTTP ${res.status}`)); }
  return res.json();
}
function setStatus(m){ el.status.textContent = m||''; }
function setRewriteStatus(m){ el.rewriteStatus.textContent = m||''; }
function stripHtml(s){ const d=document.createElement('div'); d.innerHTML=s||''; return d.innerText; }
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Diff utilities
function renderInlineBoldAdds(original, rewritten){
  const dmp = new diff_match_patch(); const diffs = dmp.diff_main(original||'', rewritten||''); dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text]) => op===1 ? '<strong>'+escapeHtml(text)+'</strong>' : op===0 ? escapeHtml(text) : '').join('');
}
function renderDiffHtml(original, rewritten){
  const dmp = new diff_match_patch(); const diffs = dmp.diff_main(original||'', rewritten||''); dmp.diff_cleanupSemantic(diffs);
  return diffs.map(([op, text]) => op===-1 ? '<del>'+escapeHtml(text)+'</del>' : op===1 ? '<ins>'+escapeHtml(text)+'</ins>' : '<span>'+escapeHtml(text)+'</span>').join('');
}
