import { embedTexts } from './llm.js';

export async function scoreResume(resume, jd, jdInfo){
  const bullets = splitBullets(resume);
  const jdTerms = [...(jdInfo.must_have||[]), ...(jdInfo.nice||[])];
  const [embBullets, embTerms] = await Promise.all([ embedTexts(bullets), embedTexts(jdTerms) ]);

  const exact = new Set();
  const semantic = new Map();
  const missingMust = [], missingNice = [];

  function hasExact(term){ return resume.toLowerCase().includes(term.toLowerCase()); }

  jdInfo.must_have.forEach((t, idx)=>{
    if (hasExact(t)) exact.add(t);
    const best = bestSim(embTerms[idx], embBullets);
    semantic.set(t, best);
    if (!hasExact(t) && best < 0.72) missingMust.push(t);
  });
  jdInfo.nice.forEach((t, i)=>{
    const idx = i + (jdInfo.must_have?.length||0);
    if (hasExact(t)) exact.add(t);
    const best = bestSim(embTerms[idx], embBullets);
    semantic.set(t, best);
    if (!hasExact(t) && best < 0.72) missingNice.push(t);
  });

  // Evidence: metrics + leadership verbs
  const ev = evidenceStats(bullets);
  let evidencePts = Math.min(20, ev.strong * 2);

  // Coverage points
  let mustPts=0; jdInfo.must_have.forEach(t=>{
    const sim = semantic.get(t)||0;
    if (exact.has(t)) mustPts += 5;
    else if (sim >= 0.78) mustPts += 3;
    else if (sim >= 0.65) mustPts += 1;
  });
  mustPts = Math.min(45, mustPts);

  let nicePts=0; jdInfo.nice.forEach(t=>{
    const sim = semantic.get(t)||0;
    if (exact.has(t)) nicePts += 2;
    else if (sim >= 0.78) nicePts += 1;
  });
  nicePts = Math.min(15, nicePts);

  const stuffingPenalty = computeStuffing(resume, jdTerms);
  let total = mustPts + nicePts + evidencePts - stuffingPenalty;
  total = Math.max(0, Math.min(100, total));
  const cap = missingMust.length ? 85 : null;
  if (cap !== null && total > cap) total = cap;

  const flags=[];
  if (stuffingPenalty >= 5) flags.push('Possible keyword stuffing');
  if (missingMust.length) flags.push('Missing required items');

  return {
    total,
    cap_reason: cap ? 'missing required items' : null,
    coverage: { exact, semantic },
    missing: { must: missingMust, nice: missingNice },
    evidence: { strong: ev.strong, with_metrics: ev.withMetrics, leadership: ev.leadership, points: evidencePts },
    flags
  };
}

// helpers
function bestSim(termVec, bulletVecs){
  let m = -1;
  for (const v of bulletVecs){ const s = dot(termVec, v); if (s>m) m=s; }
  return m;
}
function dot(a,b){ let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s; }
function tokenizeLines(text){ return (text||'').split(/\n|\u2022|•|\-/g).map(s=>s.trim()).filter(s=>s.length>8); }
function evidenceStats(bullets){
  let withMetrics=0, leadership=0, strong=0;
  for (const b of bullets){
    if (/\b(\d{1,3}(,\d{3})*|\d+\.?\d*%|\$\d|million|billion|K|QoQ|YoY)\b/i.test(b)) withMetrics++;
    if (/\b(led|owned|drove|managed|mentored|scaled|orchestrated|directed|launched|shipped)\b/i.test(b)) leadership++;
    if (/\b(led|owned|drove|managed|mentored|scaled|orchestrated|directed|launched|shipped)\b/i.test(b) || /\b(\d{1,3}(,\d{3})*|\d+\.?\d*%|\$\d|million|billion|K|QoQ|YoY)\b/i.test(b)) strong++;
  }
  return { withMetrics, leadership, strong };
}
function splitBullets(text){ return tokenizeLines(text); }
function computeStuffing(resume, terms){
  let penalty=0; const lower=resume.toLowerCase();
  for(const t of terms){
    const c = lower.split(t.toLowerCase()).length - 1;
    if (c>3) penalty += Math.min(5, c-3);
  }
  return Math.min(15, penalty);
}
