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
