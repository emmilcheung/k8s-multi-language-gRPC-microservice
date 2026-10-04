// Minimal poller: joins the queue, counts down to T0, then polls the user's
// /status, and redirects to the main site (with the admission token) once admitted.
const b = document.body.dataset;
const eid = b.eid, target = b.target, t0 = Number(b.t0), rate = Number(b.rate);
const $ = (id) => document.getElementById(id);

function fmt(s) { s = Math.max(0, Math.round(s)); const m = (s / 60) | 0; return m ? `${m}m ${s % 60}s` : `${s}s`; }

// Loading the page does not join the queue; this rate-limited POST does. The
// ticket cookie is HttpOnly, so join on every load: with a ticket already set,
// enqueue returns the same place. A refused join (say, the per-IP limit) is
// retried on the next tick; a visitor who already holds a ticket keeps polling.
let joined = false;
async function join() {
  const r = await fetch(`/api/enqueue?e=${encodeURIComponent(eid)}`, { method: "POST" });
  joined = r.ok;
}

async function tick() {
  if (!joined) await join();
  const now = Date.now();
  if (now < t0) { $("countdown").textContent = fmt((t0 - now) / 1000); return; }
  $("countdown").textContent = "open";

  const res = await fetch(`/api/status?e=${encodeURIComponent(eid)}`);
  if (res.status === 401) { joined = false; return; } // no ticket yet: join again
  const st = await res.json();
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
