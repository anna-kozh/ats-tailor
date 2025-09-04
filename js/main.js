// js/main.js
const el = {
  resumeV1: document.getElementById('resumeV1'),
  jdText: document.getElementById('jdText'),
  rewriteBtn: document.getElementById('rewriteBtn'),
  analyzeBtn: document.getElementById('analyzeBtn'),
  status: document.getElementById('status'),
  scoreV1: document.getElementById('scoreV1'),
  scoreV2: document.getElementById('scoreV2'),
  scoreV3: document.getElementById('scoreV3'),
  v2Card: document.getElementById('v2Card'),
  resumeV2: document.getElementById('resumeV2'),
  suggestionBlock: document.getElementById('suggestionBlock'),
  suggestionTitle: document.getElementById('suggestionTitle'),
  chips: document.getElementById('chips'),
  approveBtn: document.getElementById('approveBtn'),
  clearBtn: document.getElementById('clearBtn'),
  v3Card: document.getElementById('v3Card'),
  resumeV3: document.getElementById('resumeV3'),
};

let v2Text = '';
let approved = [];

function setStatus(s){ el.status.textContent = s || ''; }
function renderScore(span, score){ if (!span) return; const n = Number(score||0); span.textContent = Number.isFinite(n) ? `Score: ${n}%` : ''; }
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function callFn(action, payload) {
  const res = await fetch('/.netlify/functions/tailor', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({action, ...payload})
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return {}; }
}

el.analyzeBtn.addEventListener('click', async () => {
  const resume = el.resumeV1.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Paste resume + JD.');
  setStatus('Scoring v1…');
  try {
    const data = await callFn('analyze', { resume, jd });
    renderScore(el.scoreV1, data?.match_score);
    setStatus('Done.');
  } catch (e) {
    console.error(e); setStatus('Analyse failed.');
  }
});

el.rewriteBtn.addEventListener('click', async () => {
  const resume = el.resumeV1.value.trim();
  const jd = el.jdText.value.trim();
  if (!resume || !jd) return setStatus('Paste resume + JD.');
  setStatus('Rewriting…');
  el.v2Card.style.display = 'none';
  el.v3Card.style.display = 'none';
  approved = [];

  try {
    const data = await callFn('rewrite_full', { resume, jd });
    renderScore(el.scoreV1, data?.score_v1);
    v2Text = String(data?.rewritten_resume_v2 || '');
    el.resumeV2.innerHTML = escapeHtml(v2Text);
    el.v2Card.style.display = 'block';
    renderScore(el.scoreV2, data?.score_v2);

    const missing = Array.isArray(data?.missing_keywords) ? data.missing_keywords : [];
    renderSuggestions(missing, data?.target || 95);
    setStatus('Done.');
  } catch (e) {
    console.error(e); setStatus('Rewrite failed.');
  }
});

function renderSuggestions(keywords, target){
  const uniq = [...new Set((keywords||[]).map(s => String(s).trim()).filter(Boolean))];
  const pct = Number(target||95);
  el.suggestionTitle.textContent = `If you add these skills you get to ${pct}%`;
  el.suggestionBlock.style.display = 'block';
  el.chips.innerHTML = '';
  approved = [...uniq];
  uniq.forEach(k => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×'; x.title = 'remove';
    x.addEventListener('click', () => {
      approved = approved.filter(s => s.toLowerCase() != k.toLowerCase());
      chip.remove();
    });
    chip.append(document.createTextNode(k), x);
    el.chips.appendChild(chip);
  });

  el.approveBtn.onclick = onApprove;
  el.clearBtn.onclick = () => { approved = []; el.chips.innerHTML=''; };
}

async function onApprove(){
  const jd = el.jdText.value.trim();
  if (!v2Text || !jd) return setStatus('Nothing to approve.');
  if (!approved.length) return setStatus('No keywords selected.');
  setStatus('Applying keywords (v3)…');

  try {
    const data = await callFn('apply_keywords', { resume: v2Text, jd, keywords: approved });
    const v3 = String(data?.rewritten_resume || v2Text);
    el.resumeV3.innerHTML = escapeHtml(v3);
    el.v3Card.style.display = 'block';
    renderScore(el.scoreV3, data?.final_score);

    const remaining = Array.isArray(data?.remaining_keywords) ? data.remaining_keywords : [];
    if (remaining.length) {
      renderSuggestions(remaining, data?.target || 95);
    } else {
      el.suggestionBlock.style.display = 'none';
    }
    setStatus('Done.');
  } catch (e) {
    console.error(e); setStatus('Approve failed.');
  }
}
