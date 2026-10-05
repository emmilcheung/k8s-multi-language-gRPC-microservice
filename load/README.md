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

Mirrors what the real waiting page (`services/queue-service/src/QueueService/wwwroot/js/wait.js`)
sends against the standalone queue-service (`docker-compose.queue.yml`). Two scenarios:

- `serving` hammers `GET /api/serving?e=<id>` with no think time. It is answered from
  a per-pod in-memory snapshot (refreshed at most once a second per event, single-flight),
  so a hit does no Redis work and latency must stay flat regardless of VU count.
- `flow` is one visitor's journey with the page's own intervals: `POST /api/enqueue`,
  then **one** `GET /api/status` 0-10 s later (that call freezes the position; it is
  never repeated), then `GET /api/serving` every 15-30 s (random each time), and
  `POST /api/claim` once `serving > position`. A claim answered 425 (this pod is a
  moment behind) or 409 (paused / sold out) goes back to polling.

### Rush profile and budget

The page asks for as little as possible, so a rush of N visitors costs N enqueues, N
status calls and then N/22 serving polls per second (22 s is the mean poll gap) instead
of N/2. Thresholds: `flow_failed` < 1% (any failed request counts, **a 401 on status
included** since the real page would have to join again), `status_calls_per_visitor` max 1,
and the usual latency bounds. The Redis budget cannot be read from k6, so measure it
around the run: the config read (`HGETALL`) rate is bounded by pods x events x 1/s, not by
visitors, and `EVAL` (enqueue/freeze scripts) tracks joins only.

```bash
docker compose -f docker-compose.queue.yml up -d
# seed an already-open, high-rate event (fields: t0 ms, rate per second, armed;
# optional servingBase + tBase ms rebase the count, soldout / paused are 0 or 1)
docker compose -f docker-compose.queue.yml exec -T queue-redis redis-cli \
  HSET q:{LOAD}:cfg t0 $(( ($(date +%s) - 30) * 1000 )) rate 1000 armed 1
docker compose -f docker-compose.queue.yml exec -T queue-redis redis-cli CONFIG RESETSTAT
k6 run -e QUEUE_EVENT=LOAD -e PEAK_VUS=400 load/k6/onsale-queue.js
docker compose -f docker-compose.queue.yml exec -T queue-redis redis-cli INFO commandstats | grep -E 'hgetall|eval'
```

The key is `q:{<id>}:cfg`; the braces are literal (a Redis Cluster hash tag), so quote
them if your shell expands braces. Edit the hash by hand only to create an event: once a
sale is running, change it through the admin API below, because a plain `HSET rate`
makes serving jump.

Not re-measured after the snapshot and wait.js changes: the figures below are from
2026-06-16 against the previous design (every serving call computed from a Redis read).
Rerun the commands above to refresh them.

Measured (2026-06-16, local M-series + Docker, 500 peak VUs / ~31k req/s): `serving`
p95 19.5 ms / p99 26 ms, **0% failures across 901k requests; 2.44M checks 100% passed**.

### Operating a running sale

Set `Queue__AdminApiKey` (32+ chars) and the service maps these routes (not mapped
otherwise); send the key in `X-Queue-Admin-Key`. They take effect on every pod within
about a second.

```bash
H='X-Queue-Admin-Key: <key>'; U=http://localhost:4100/api/admin/events/<id>
# New rate; serving continues from where it is, no jump
curl -X POST $U/rate     -H "$H" -H 'Content-Type: application/json' -d '{"rate": 200}'
# Stop admitting (serving freezes) / resume (continues from there, no burst)
curl -X POST $U/paused   -H "$H" -H 'Content-Type: application/json' -d '{"paused": true}'
# Mark sold out (claims refused with 409; the page says so)
curl -X POST $U/sold-out -H "$H" -H 'Content-Type: application/json' -d '{"soldOut": true}'
```

With `Queue__VenueAvailabilityUrl` set, the pods also pause (no seats free but some held)
or mark sold out (none free, none held) on their own, ORed with the operator's flags.

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
