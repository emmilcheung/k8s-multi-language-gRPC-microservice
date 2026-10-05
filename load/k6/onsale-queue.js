// k6 waiting-room load — models what services/queue-service/src/QueueService/wwwroot/js/wait.js
// really sends, so the request mix and the Redis cost match a real sale.
//   serving : GET QUEUE_URL/api/serving?e=<id>   unthrottled hammer on the cacheable hot path
//   flow    : one visitor's journey, same intervals as wait.js:
//             POST /api/enqueue, ONE GET /api/status 0-10 s later (it freezes the position),
//             then GET /api/serving every 15-30 s and POST /api/claim once serving > position.
// A serving hit does no Redis work (per-pod snapshot, refreshed at most once a second), and a
// visitor sends exactly one status call, so Redis load must stay flat as visitors grow. Seed
// the event first (see load/README.md).
//
//   k6 run -e QUEUE_EVENT=<id> -e PEAK_VUS=400 load/k6/onsale-queue.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const QUEUE_URL = __ENV.QUEUE_URL || "http://localhost:4100";
const EVENT = __ENV.QUEUE_EVENT || "E2E";
const PEAK_VUS = Number(__ENV.PEAK_VUS || 300);
const STAGE = __ENV.STAGE || "20s";
// A visitor stops polling after this many serving polls if never admitted (keeps a run bounded).
const MAX_POLLS = Number(__ENV.MAX_POLLS || 6);

const flowFailed = new Rate("flow_failed");              // any join/status/serving/claim failure, 401 included
const statusCalls = new Trend("status_calls_per_visitor"); // the Redis budget: one freeze per visitor

export const options = {
  scenarios: {
    serving: {
      executor: "ramping-vus", exec: "serving",
      stages: [
        { duration: STAGE, target: PEAK_VUS },
        { duration: STAGE, target: PEAK_VUS },
        { duration: "5s", target: 0 },
      ],
    },
    flow: {
      executor: "ramping-vus", exec: "flow", gracefulStop: "90s",
      stages: [
        { duration: STAGE, target: Math.ceil(PEAK_VUS / 4) },
        { duration: STAGE, target: Math.ceil(PEAK_VUS / 4) },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_failed{name:serving}": ["rate<0.01"],
    // serving is answered from memory — must stay fast under the full VU load.
    "http_req_duration{scenario:serving}": ["p(95)<50", "p(99)<150"],
    "http_req_duration{scenario:flow}": ["p(95)<150", "p(99)<400"],
    // A 401 on status (lost ticket cookie) counts: the real client would have to re-join.
    flow_failed: ["rate<0.01"],
    // Redis budget: a visitor freezes its position once, so status is never called twice.
    status_calls_per_visitor: ["max<=1"],
  },
};

export function serving() {
  const res = http.get(`${QUEUE_URL}/api/serving?e=${EVENT}`, { tags: { name: "serving" } });
  check(res, {
    "serving 200": (r) => r.status === 200,
    "serving cacheable": (r) => /max-age/.test(r.headers["Cache-Control"] || ""),
    "serving is a number": (r) => typeof r.json("serving") === "number",
  });
}

const between = (lo, hi) => lo + Math.random() * (hi - lo);

export function flow() {
  const base = `${QUEUE_URL}/api`;
  const enq = http.post(`${base}/enqueue?e=${EVENT}`, null, { tags: { name: "enqueue" } });
  let ok = check(enq, { "enqueue 200": (r) => r.status === 200 });

  sleep(between(0, 10)); // the jittered window after T0 in wait.js
  const st = http.get(`${base}/status?e=${EVENT}`, { tags: { name: "status" } });
  statusCalls.add(1);
  ok = check(st, { "status 200": (r) => r.status === 200 }) && ok; // 401 is a failure here
  if (!ok) { flowFailed.add(true); return; }

  const position = st.json("position");
  let servingNow = st.json("serving");
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    if (position < servingNow) {
      const claim = http.post(`${base}/claim?e=${EVENT}`, null, { tags: { name: "claim" } });
      // 425 (this pod's snapshot a moment behind) and 409 (paused / sold out) mean poll again.
      if (check(claim, { "claim ok": (r) => [200, 425, 409].includes(r.status) }) && claim.status === 200) {
        flowFailed.add(false);
        return;
      }
      if (claim.status !== 425 && claim.status !== 409) { flowFailed.add(true); return; }
    }
    sleep(between(15, 30));
    const sv = http.get(`${base}/serving?e=${EVENT}`, { tags: { name: "serving" } });
    if (!check(sv, { "serving poll 200": (r) => r.status === 200 })) { flowFailed.add(true); return; }
    servingNow = sv.json("serving");
  }
  flowFailed.add(false);
}
