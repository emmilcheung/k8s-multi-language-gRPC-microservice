# Load Testing

k6 scenarios that turn the platform's caching/SLO claims into measured numbers.
SLOs + the recorded baseline live in [`docs/18-slos-and-load-testing.md`](../docs/18-slos-and-load-testing.md).

## Prerequisites

- `brew install k6`
- Full local stack: `docker compose up -d` (repo root), then the production client:
  `cd services/client && pnpm build && pnpm start -p 4000`
- At least one seeded GA ticket (the graphql-seed container handles this; for a
  realistic hot-ticket run, create one with a large quota and pass its id).

## Onsale read storm — `k6/onsale-read.js`

Hammers one hot ticket on two paths in parallel: the ISR page (`:4000/tickets/<id>`)
and the GraphQL detail query via Kong (`:8000/graphql`). Thresholds encode the SLOs.

```bash
# Default laptop profile (~70s, 200 peak page VUs + 100 API VUs)
k6 run load/k6/onsale-read.js

# Bigger / targeted run
k6 run -e TICKET_ID=<uuid> -e PEAK_VUS=400 -e STAGE=60s load/k6/onsale-read.js
```

### Evidencing "origin reads stay flat" (the SWR claim)

Capture MongoDB opcounters around the run; the query delta should stay tiny
relative to total HTTP requests served:

```bash
docker compose exec -T mongodb mongosh --quiet --eval 'print(JSON.stringify(db.serverStatus().opcounters))'
# run k6 ...
docker compose exec -T mongodb mongosh --quiet --eval 'print(JSON.stringify(db.serverStatus().opcounters))'
```

## Onsale waiting room — `k6/onsale-queue.js`

Polling storm against the standalone queue-service (`docker-compose.queue.yml`).
The `serving` scenario hammers `GET /api/serving?e=<id>` — the cacheable hot path
whose admission count is pure time-math (`floor(rate·(now−T0))`, no Redis), so its
latency must stay flat regardless of VU count. The `flow` scenario exercises the
per-visitor `enqueue → status` path.

```bash
docker compose -f docker-compose.queue.yml up -d
# seed an already-open, high-rate event
docker compose -f docker-compose.queue.yml exec -T queue-redis redis-cli \
  HSET q:LOAD:cfg t0 $(( ($(date +%s) - 30) * 1000 )) rate 1000 armed 1
k6 run -e QUEUE_EVENT=LOAD -e PEAK_VUS=400 load/k6/onsale-queue.js
```

Measured (2026-06-16, local M-series + Docker, 500 peak VUs / ~31k req/s): `serving`
p95 19.5 ms / p99 26 ms, **0% failures across 901k requests; 2.44M checks 100% passed**
— the time-math read path absorbs the storm with flat latency, evidencing the
origin-load invariant for the gate.

## Caveats

- **Kong's anonymous IP rate limit (6,000/min locally) throttles the `api`
  scenario** when all load comes from one machine — expect 429s beyond the
  allowance. That is the gateway working correctly; see the finding in
  `docs/18-slos-and-load-testing.md` for how to measure past it.

- Local numbers (laptop + Docker Desktop) are **not** production numbers. The
  methodology and the *relative* flatness of origin load are the point — absolute
  RPS/latency must be re-baselined on real infra.
- Phase 2 (read storm + concurrent reservations exercising the no-invalidate SWR
  path) is a documented follow-up: run the Playwright purchase flow — or a second
  authenticated k6 script — concurrently with `onsale-read.js` and confirm the
  read thresholds still hold while `reserved` counters move.
