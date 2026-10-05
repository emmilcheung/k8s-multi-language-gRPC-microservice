// Waiting-room client. It spends as few requests as it can, because a whole sale
// runs this script at once: join once, count down locally, ask for the frozen
// position exactly once (spread over the first seconds after T0), then poll the
// cacheable /serving every 15-30 s and work out the wait locally. It claims only
// once serving has passed its position, then redirects with the admission token.
const b = document.body.dataset;
const eid = b.eid, target = b.target, t0 = Number(b.t0);
const q = encodeURIComponent(eid);
const $ = (id) => document.getElementById(id);

let position = null, serving = 0, rate = Number(b.rate), soldOut = false, paused = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (minMs, maxMs) => minMs + Math.random() * (maxMs - minMs);
function fmt(s) { s = Math.max(0, Math.round(s)); const m = (s / 60) | 0; return m ? `${m}m ${s % 60}s` : `${s}s`; }

// Loading the page does not join the queue; this rate-limited POST does. The
// ticket cookie is HttpOnly, so join on every load: with a ticket already set,
// enqueue returns the same place.
async function join() {
  try { return (await fetch(`/api/enqueue?e=${q}`, { method: "POST" })).ok; } catch { return false; }
}

// Calling status after T0 freezes the position, so it is called once; it is
// repeated only when it fails, and a 401 (no ticket) joins again first.
async function freezePosition() {
  for (;;) {
    try {
      const res = await fetch(`/api/status?e=${q}`);
      if (res.ok) { const st = await res.json(); position = st.position; apply(st); return; }
      if (res.status === 401) await join();
    } catch { /* network error: retry */ }
    await sleep(jitter(2000, 5000));
  }
}

function apply(st) {
  serving = st.serving; soldOut = !!st.soldOut; paused = !!st.paused;
  if (st.rate) rate = st.rate;
}

async function pollServing() {
  try {
    const res = await fetch(`/api/serving?e=${q}`);
    if (res.ok) apply(await res.json());
  } catch { /* keep the last numbers; try again next round */ }
}

function render() {
  $("soldout").hidden = !soldOut;
  $("paused").hidden = soldOut || !paused;
  if (position === null) return;
  const ahead = Math.max(0, position - serving);
  $("pos").textContent = position;
  $("wait").textContent = paused || soldOut ? "—" : fmt(ahead / rate);
}

// Returns true when the page is being redirected.
async function claim() {
  try {
    const res = await fetch(`/api/claim?e=${q}`, { method: "POST" });
    if (res.status === 401) { if (await join()) await freezePosition(); return false; }
    if (!res.ok) return false; // 425 too early, 409 paused or sold out: keep polling
    const { token } = await res.json();
    const sep = target.includes("?") ? "&" : "?";
    window.location = `${target}${sep}qpass=${encodeURIComponent(token)}`;
    return true;
  } catch { return false; }
}

async function run() {
  while (!(await join())) await sleep(jitter(2000, 5000)); // e.g. the per-IP limit: back off and retry

  const countdown = setInterval(() => {
    const left = t0 - Date.now();
    $("countdown").textContent = left > 0 ? fmt(left / 1000) : "open";
  }, 1000);
  $("countdown").textContent = fmt(Math.max(0, t0 - Date.now()) / 1000);

  // A random moment in the first 10 s after T0; immediately for a page loaded later.
  await sleep(Math.max(0, t0 + jitter(0, 10000) - Date.now()));
  clearInterval(countdown);
  $("countdown").textContent = "open";
  await freezePosition();

  for (;;) {
    render();
    if (position < serving && !soldOut && !paused && (await claim())) return;
    await sleep(jitter(15000, 30000));
    await pollServing();
  }
}
run();
