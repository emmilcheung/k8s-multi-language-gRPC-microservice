// Minimal poller: counts down to T0, then polls cached /serving and the user's
// /status, and redirects to the main site (with the admission token) once admitted.
const b = document.body.dataset;
const eid = b.eid, target = b.target, t0 = Number(b.t0), rate = Number(b.rate);
const $ = (id) => document.getElementById(id);

function fmt(s) { s = Math.max(0, Math.round(s)); const m = (s / 60) | 0; return m ? `${m}m ${s % 60}s` : `${s}s`; }

async function tick() {
  const now = Date.now();
  if (now < t0) { $("countdown").textContent = fmt((t0 - now) / 1000); return; }
  $("countdown").textContent = "open";

  const st = await fetch(`/api/status?e=${encodeURIComponent(eid)}`).then(r => r.json());
  $("pos").textContent = st.position;
  $("wait").textContent = fmt(st.waitSeconds);

  if (st.admitted) {
    const { token } = await fetch(`/api/claim?e=${encodeURIComponent(eid)}`, { method: "POST" }).then(r => r.json());
    if (token) {
      const sep = target.includes("?") ? "&" : "?";
      window.location = `${target}${sep}qpass=${encodeURIComponent(token)}`;
    }
  }
}
setInterval(tick, 2000);
tick();
