// js/main.js
const $resume = document.getElementById('resume');
const $jd = document.getElementById('jd');
const $rewrite = document.getElementById('rewriteBtn');
const $status = document.getElementById('status');
const $v2 = document.getElementById('v2');
const $scoreV1 = document.getElementById('scoreV1');
const $scoreV2 = document.getElementById('scoreV2');

function setStatus(msg, spinning=false){
  if(!msg){ $status.textContent=''; return; }
  $status.innerHTML = spinning ? `<span class="spinner" aria-hidden="true"></span> ${msg}` : msg;
}

function setPill($el, label, score){
  if (typeof score !== 'number' || isNaN(score)) {
    $el.className = 'pill bad';
    $el.textContent = `${label}: —`;
    return;
  }
  const cls = score >= 95 ? 'ok' : score >= 75 ? 'warn' : 'bad';
  $el.className = `pill ${cls}`;
  $el.textContent = `${label}: ${Math.round(score)}`;
}

function htmlEscape(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

$rewrite.addEventListener('click', async () => {
  const resume = $resume.value.trim();
  const jd = $jd.value.trim();

  if(!resume || !jd){
    setStatus('Please paste both Resume and JD.', false);
    return;
  }

  // Clear previous results
  $v2.textContent = '—';
  $v2.classList.add('muted');
  setPill($scoreV1, 'v1', NaN);
  setPill($scoreV2, 'v2', NaN);

  $rewrite.disabled = true;
  setStatus('Working on your resume…', true);

  try {
    const resp = await fetch('/.netlify/functions/rewrite', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ resume, jd })
    });
    if(!resp.ok){
      const t = await resp.text().catch(()=>'');
      throw new Error(`Server error ${resp.status}: ${t || resp.statusText}`);
    }
    const data = await resp.json();

    // Expect: { v2Text, scoreV1, scoreV2, boldedV2 }
    const { v2Text, scoreV1, scoreV2, boldedV2 } = data;

    setPill($scoreV1, 'v1', scoreV1);
    setPill($scoreV2, 'v2', scoreV2);

    $v2.innerHTML = boldedV2 ? boldedV2 : htmlEscape(v2Text || 'No output');
    $v2.classList.remove('muted');
    setStatus('Done ✓');

  } catch (err){
    console.error(err);
    setStatus(`Error: ${err.message || err}`, false);
  } finally {
    $rewrite.disabled = false;
  }
});
