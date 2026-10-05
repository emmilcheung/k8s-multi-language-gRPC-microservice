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
// repeated only when it fails, and a 401 (no ticket) joins again first. A network
// error, 5xx or 429 is retried for as long as it lasts, but a permanent answer such as 404 gets
// a few tries with growing pauses and then gives up (returns false).
async function freezePosition() {
  for (let refused = 0; refused < 5;) {
    try {
      const res = await fetch(`/api/status?e=${q}`);
      if (res.ok) { const st = await res.json(); position = st.position; apply(st); return true; }
      if (res.status === 401) await join();
      else if (res.status < 500 && res.status !== 408 && res.status !== 429) refused++; // permanent
    } catch { /* network error: retry */ }
    await sleep(jitter(2000, 5000) * 2 ** refused);
  }
  return false;
}

// Pods learn of a pause or rate change up to a few seconds apart, so a poll can
// answer with a lower number than an earlier one; the count never goes back.
function apply(st) {
  serving = Math.max(serving, st.serving);
  soldOut = !!st.soldOut; paused = !!st.paused;
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
  if (!(await freezePosition())) {
    // Giving up must not leave "—" with no explanation; a reload starts over and joins again.
    $("gaveup").hidden = false;
    $("retry").onclick = () => location.reload();
    return;
  }

  for (;;) {
    render();
    if (position < serving && !soldOut && !paused && (await claim())) return;
    await sleep(jitter(15000, 30000));
    await pollServing();
  }
}
run();
