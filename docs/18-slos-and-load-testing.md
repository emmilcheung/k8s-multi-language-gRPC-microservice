# SLOs & Load Testing

Service-level objectives for the public read path, and the load-test methodology
that keeps them honest. Scripts live in [`load/`](../load/README.md).

## SLIs / SLOs — public ticket read path

| SLI | SLO (local baseline target) | Where enforced |
|---|---|---|
| Ticket page availability (`GET /tickets/:id`) | 99.9% non-5xx | k6 threshold `http_req_failed < 0.1%` |
| Ticket page latency | p95 < 300 ms, p99 < 800 ms | k6 `scenario:page` thresholds |
| Ticket detail GraphQL latency (via Kong) | p95 < 150 ms, p99 < 400 ms | k6 `scenario:api` thresholds |
| Page cacheability | `Cache-Control: public, s-maxage` present on every shell response | k6 check `page cacheable` |
| **Consistency budget** | displayed availability may lag ≤ SWR soft TTL (5 s); exact count enforced only at reserve (Mongo CAS) | design invariant — see `docs/superpowers/specs/2026-06-09-multi-instance-read-cache-design.md` |
| **Origin-load invariant** | MongoDB query opcounters stay ~flat under read RPS (SWR cache absorbs the storm) | opcounter delta around a k6 run (`load/README.md`) |

Error budget: 0.1% of read requests per 30-day window. Burning it (sustained
5xx or threshold breaches) halts read-path feature work in favor of reliability.

> **Local numbers are baselines, not production claims.** Laptop + Docker Desktop
> measures the *methodology* and relative behavior (flat origin load, cacheable
> headers); absolute targets must be re-baselined on real infra before being
> treated as production SLOs.

## Measured baseline (2026-06-10, local: M-series laptop + Docker Desktop)

Two runs of `load/k6/onsale-read.js` against the full compose stack + production
Next build (`pnpm start`), single hot ticket:

| Metric | Run 1 (PEAK_VUS=200, ~70s) | Run 2 (PEAK_VUS=150, ~40s) |
|---|---|---|
| Total HTTP reqs | 176,499 (~2,416/s) | 91,570 (~1,998/s) |
| Page p95 / p99 | 106 ms / 119 ms ✅ | 80 ms / — ✅ |
| Page failures | 0 ✅ | 0 ✅ |
| `page cacheable` check | 100% ✅ | 100% ✅ |
| GraphQL-via-Kong | 18% pass — see finding below | (same) |
| **Mongo `query` opcounter** | **31 cumulative since stack boot** across BOTH runs (~270k HTTP reads) — the origin-load invariant holds decisively | |

### Finding: Kong's anonymous rate limiter throttles single-IP load tests

The `api` scenario's "failures" are HTTP 429 from Kong's anonymous IP rate limit
(6,000/min locally): ~10.3k of ~55k direct GraphQL calls passed — exactly the
allowance. This is the gateway **working as designed** against a single-source
flood, and it doubles as evidence for the layering: the *page* path served 100%
of ~120k requests because ISR answers from cache and only revalidates upstream
~once per 30s — the rate limiter never sees buyer page traffic.

Consequence for methodology: to measure raw API capacity beyond 6k/min, either
run distributed load sources or temporarily raise `rateLimit` in the Kong local
values. Do **not** weaken the production limit for testing.
