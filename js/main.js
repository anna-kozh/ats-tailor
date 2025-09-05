(() => {
  const $ = (id) => document.getElementById(id);
  const rewriteBtn = $("rewriteBtn");
  const status = $("status");
  const scoreV1 = $("scoreV1");
  const scoreV2 = $("scoreV2");
  const v2Out = $("v2");
  const debug = $("debug");
  const resumeEl = $("resume");
  const jdEl = $("jd");

  function setScorePill(el, label, score){
    el.textContent = `${label}: ${score === null ? "—" : Math.round(score)}`;
    el.classList.remove("ok","warn","bad");
    if (score === null) { el.classList.add("bad"); return; }
    if (score >= 95) el.classList.add("ok");
    else if (score >= 75) el.classList.add("warn");
    else el.classList.add("bad");
  }

  async function rewrite(){
    const resumeV1 = resumeEl.value.trim();
    const jd = jdEl.value.trim();
    // Clear previous state
    setScorePill(scoreV1, "v1", null);
    setScorePill(scoreV2, "v2", null);
    v2Out.textContent = "—";
    v2Out.classList.add("muted");
    debug.textContent = "—";
    debug.classList.add("muted");

    if(!resumeV1 || !jd){
      status.textContent = "Paste both resume and JD.";
      return;
    }
    try {
      rewriteBtn.disabled = true;
      status.innerHTML = `<span class="spinner"></span> Rewriting with OpenAI…`;
      const res = await fetch("/.netlify/functions/rewrite", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ resumeV1, jd })
      });
      if(!res.ok){
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const data = await res.json();
      setScorePill(scoreV1, "v1", data.scoreV1);
      setScorePill(scoreV2, "v2", data.scoreV2);
      v2Out.textContent = data.resumeV2 || "—";
      v2Out.classList.toggle("muted", !data.resumeV2);
      debug.textContent = JSON.stringify(data.details, null, 2);
      debug.classList.remove("muted");
      status.textContent = data.scoreV2 >= 95 ? "Done." : "Reached max passes; tweak v1 for better fit.";
    } catch (err){
      console.error(err);
      status.textContent = err.message || "Error. See console.";
    } finally {
      rewriteBtn.disabled = false;
    }
  }

  rewriteBtn.addEventListener("click", rewrite);
})();