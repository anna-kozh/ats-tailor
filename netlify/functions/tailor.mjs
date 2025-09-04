export default async function handler(request) {
  try {
    // Health
    if (request.method === 'GET') {
      return J({ ok: true, msg: 'tailor up' }, 200);
    }
    if (request.method !== 'POST') return J({ error: 'Method Not Allowed' }, 405);

    // Check env
    const hasKey = !!process.env.OPENAI_API_KEY;
    if (!hasKey) return J({ step: 'env', error: 'Missing OPENAI_API_KEY' }, 500);

    // Read body (and show it back if invalid)
    let raw = await request.text();
    let parsed;
    try { parsed = JSON.parse(raw || '{}'); }
    catch (e) { return J({ step: 'parse', raw, error: String(e) }, 400); }

    const { action, resume, jd, mode = 'conservative' } = parsed || {};
    if (!resume || !jd) return J({ step: 'validate', error: 'resume or jd missing' }, 400);
    if (!['analyze', 'rewrite'].includes(action)) return J({ step: 'validate', error: 'bad action', action }, 400);

    // Probe OpenAI connectivity (no spend)
    const probe = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    if (!probe.ok) {
      const t = await probe.text();
      return J({ step: 'openai-probe', status: probe.status, body: t }, 502);
    }

    // If probe passes, we’re good—return summary so we know sizes
    return J({ ok: true, step: 'ready', action, mode,
               len: { resume: (resume||'').length, jd: (jd||'').length } }, 200);
  } catch (err) {
    return J({ step: 'crash', error: String(err) }, 502);
  }
}
function J(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' }
  });
}
