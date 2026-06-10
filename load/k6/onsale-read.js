// k6 onsale read-storm — measures the hot ticket read path under load.
//
// Two scenarios run in parallel against a single "hot" ticket:
//   page : GET  CLIENT_URL/tickets/<id>      (Next.js ISR shell — the page buyers hammer)
//   api  : POST KONG_URL/graphql ticket(id)  (ticket-service via Apollo Router — the SWR cache path)
//
// The claim under test: origin (MongoDB) reads stay ~flat as read RPS scales,
// because the shared-Redis SWR cache absorbs the storm (soft TTL 5s, single
// fleet-wide refresh). Capture Mongo opcounters before/after (see load/README.md)
// to evidence it — k6 itself proves latency/error SLOs hold.
//
// Usage (defaults are laptop-sized; see load/README.md):
//   k6 run load/k6/onsale-read.js
//   k6 run -e TICKET_ID=<uuid> -e PEAK_VUS=300 -e STAGE=60s load/k6/onsale-read.js

import http from "k6/http";
import { check } from "k6";

const KONG_URL = __ENV.KONG_URL || "http://localhost:8000";
const CLIENT_URL = __ENV.CLIENT_URL || "http://localhost:4000";
const PEAK_VUS = Number(__ENV.PEAK_VUS || 200);
const STAGE = __ENV.STAGE || "30s";

export const options = {
  scenarios: {
    page: {
      executor: "ramping-vus",
      exec: "page",
      stages: [
        { duration: STAGE, target: Math.ceil(PEAK_VUS / 4) },
        { duration: STAGE, target: PEAK_VUS },
        { duration: "10s", target: 0 },
      ],
    },
    api: {
      executor: "ramping-vus",
      exec: "api",
      stages: [
        { duration: STAGE, target: Math.ceil(PEAK_VUS / 8) },
        { duration: STAGE, target: Math.ceil(PEAK_VUS / 2) },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    // SLOs from docs/18-slos-and-load-testing.md (local baseline targets).
    "http_req_failed": ["rate<0.001"],
    "http_req_duration{scenario:page}": ["p(95)<300", "p(99)<800"],
    "http_req_duration{scenario:api}": ["p(95)<150", "p(99)<400"],
  },
};

// Resolve the hot ticket once; reused by every VU iteration.
export function setup() {
  if (__ENV.TICKET_ID) return { ticketId: __ENV.TICKET_ID };
  const res = http.post(
    `${KONG_URL}/graphql`,
    JSON.stringify({ query: "{ ticketsConnection(first:1){ edges { node { id } } } }" }),
    { headers: { "Content-Type": "application/json" } },
  );
  const id = res.json("data.ticketsConnection.edges.0.node.id");
  if (!id) throw new Error(`no seeded ticket found via ${KONG_URL}/graphql (status ${res.status})`);
  return { ticketId: id };
}

export function page(data) {
  const res = http.get(`${CLIENT_URL}/tickets/${data.ticketId}`, {
    tags: { name: "ticket-page" },
  });
  check(res, {
    "page 200": (r) => r.status === 200,
    // The whole point: the shell must be publicly cacheable, never private.
    "page cacheable": (r) => /s-maxage/.test(r.headers["Cache-Control"] || ""),
  });
}

const DETAIL_QUERY = `query($id: ID!) {
  ticket(id: $id) { id title priceDecimal available ticketType event { title startsAt venueName } }
}`;

export function api(data) {
  const res = http.post(
    `${KONG_URL}/graphql`,
    JSON.stringify({ query: DETAIL_QUERY, variables: { id: data.ticketId } }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "ticket-detail-gql" } },
  );
  check(res, {
    "gql 200": (r) => r.status === 200,
    "gql has data": (r) => r.json("data.ticket.id") === data.ticketId,
  });
}
