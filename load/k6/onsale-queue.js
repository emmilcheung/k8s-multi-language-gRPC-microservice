// k6 waiting-room load — proves the queue read path absorbs a polling storm.
//   serving : GET QUEUE_URL/api/serving?e=<id>   (pure time-math, cacheable — the hot path)
//   flow    : POST /api/enqueue then GET /api/status (per-visitor path)
// The serving endpoint does no Redis work (admission = floor(rate*(now-T0))), so its
// latency must stay flat regardless of VU count. Seed the event first (see load/README.md).
//
//   k6 run -e QUEUE_EVENT=<id> -e PEAK_VUS=400 load/k6/onsale-queue.js
import http from "k6/http";
import { check } from "k6";

const QUEUE_URL = __ENV.QUEUE_URL || "http://localhost:4100";
const EVENT = __ENV.QUEUE_EVENT || "E2E";
const PEAK_VUS = Number(__ENV.PEAK_VUS || 300);
const STAGE = __ENV.STAGE || "20s";

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
      executor: "ramping-vus", exec: "flow",
      stages: [
        { duration: STAGE, target: Math.ceil(PEAK_VUS / 4) },
        { duration: STAGE, target: Math.ceil(PEAK_VUS / 4) },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    // serving is pure compute — must stay fast under the full VU load.
    "http_req_duration{scenario:serving}": ["p(95)<50", "p(99)<150"],
    "http_req_duration{scenario:flow}": ["p(95)<150", "p(99)<400"],
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

export function flow() {
  const enq = http.post(`${QUEUE_URL}/api/enqueue?e=${EVENT}`, null, { tags: { name: "enqueue" } });
  const jar = http.cookieJar();
  const cookies = jar.cookiesForURL(`${QUEUE_URL}/`);
  const st = http.get(`${QUEUE_URL}/api/status?e=${EVENT}`, { tags: { name: "status" }, cookies });
  check(enq, { "enqueue 200": (r) => r.status === 200 });
  check(st, { "status ok": (r) => r.status === 200 || r.status === 401 });
}
