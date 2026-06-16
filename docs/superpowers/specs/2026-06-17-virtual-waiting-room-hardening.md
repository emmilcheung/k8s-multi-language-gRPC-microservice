# Virtual Waiting Room — Security & Reliability Remediation

> **Date:** 2026-06-17 · **Branch:** `feat/virtual-waiting-room` · **Scope:** the queue-service
> (ASP.NET Core 10), its connector (Next.js `proxy.ts` + Kong backstop), and its
> Helm chart. Prepared for external security review.

This documents the self-audit of the virtual waiting room and the remediation of
every finding. Each fix ships with a test that demonstrates the failure mode is
blocked (not just a happy-path test). Status legend: **FIXED** (closed in code +
test), **MITIGATED** (residual operational requirement), **OPERATIONAL** (no code
fix possible — deployment/ops control).

## Remediation summary

| # | Finding | Severity | Status | Commit | Proof |
|---|---|---|---|---|---|
| 1 | Open redirect + admission-token exfiltration via waiting-page `target` | High | **FIXED** | `f1fab10` | 12 unit tests (attack inputs) + live smoke (`target=https://evil.com` → `/`) |
| 2 | No rate limit; unbounded pre-queue growth (queue self-DoS) | High | **FIXED** | `914e721` | per-IP 429 test; atomic pre-queue cap (503) test |
| 3 | No TTL / cleanup on Redis keys | Med-High | **FIXED** | `914e721` | key-TTL test (PTTL > 0 after enqueue) |
| 4 | Known default HMAC secret usable in prod | High | **FIXED** | `1c68200` | prod-rejects-placeholder test; dev-allows test |
| 5 | Replayable bearer admission token (nonce unused) | Med-High | **FIXED** | `0a0db48` | single-use test (200→409); live smoke replay → 409 |
| 6 | Redis single point of failure; fail-open on data loss | High | **MITIGATED** | `990eacf` | AOF persistence + PVC; external-Redis escape hatch (see residual) |
| 7 | Health check ignored Redis (false healthy) | Med | **FIXED** | `6d2ab5e` | `/readyz` Redis-ping check; health-endpoint test |
| 8 | No HPA, no PDB | Med | **FIXED** | `990eacf` | `helm template` renders HPA + PDB; toggle variants validated |
| 9 | Clock-skew sensitivity (serving + token expiry) | Med | **OPERATIONAL** | — | requires NTP on all replicas (see residual) |
| 10 | Concurrency races in late-position / freeze | Med | **FIXED** | `cfb91b6` | atomic Lua; concurrency tests (100 distinct contiguous; 50 same-mid burn 1 slot) |
| 11 | Bad input → 500 (no validation) | Med | **FIXED** | `ced8865` | unknown-event 404, forged-cookie 401, too-early 425 tests |
| 12 | No observability (metrics/traces) | Med | **FIXED** | `6d2ab5e` | OTel meter (enqueued/admitted/rejected + wait histogram) + OTLP export |
| 13 | No authenticated admin/config API | Low-Med | **RESIDUAL** | — | events still configured via Redis (see residual) |

Verification footprint: **50** queue-service unit/integration tests (incl. HTTP-boundary,
abuse, concurrency, replay, secret) + **9** client gate tests + a live container smoke
of the hardened security paths. All green.

## Fix detail

- **#1** `RedirectSafety.SafeTarget` rejects anything not a same-origin absolute path
  (`//evil`, `/\evil`, `scheme:`, CRLF → `/`), applied server-side before render.
- **#2/#3** `/api/enqueue` is per-IP fixed-window rate-limited (429); pre-queue adds are
  an atomic Lua script enforcing a hard size cap (503 when full) and `PEXPIRE` on all
  event keys (self-cleaning).
- **#4** Startup fails in Production if `Queue:HmacSecret` equals the shipped placeholder.
- **#5** `/api/redeem` consumes the token nonce once (Redis `SETNX`+TTL); the connector
  redeems a `qpass` before setting the cookie and fails closed if the queue is down.
- **#7/#12** liveness `/healthz` vs Redis-aware readiness `/readyz`; OpenTelemetry
  metrics + traces (OTLP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set).
- **#10** late-position and freeze are single atomic Lua scripts (no check-then-write).
- **#11** typed `EventNotFoundException`→404, forged ticket→401, too-early claim→425,
  ProblemDetails for unhandled (no stack leak).
- **#6/#8** Redis AOF + PVC; HPA (CPU 3–20), PDB (minAvailable 2); external-Redis option.

## Residual risks (must be closed at deploy time)

1. **Redis HA (#6):** the in-chart Redis is a single pod — still a SPOF. Production
   **must** set `redis.external.host` to a replicated/managed Redis (ElastiCache /
   MemoryStore / Sentinel). AOF only protects against restart, not node loss.
2. **Real client IP for rate limiting (#2):** the limiter partitions on
   `RemoteIpAddress`. Behind an ingress, enable `ForwardedHeaders` with **trusted**
   proxies — do not trust raw `X-Forwarded-For`, or the per-IP limit is bypassable.
3. **Clock skew (#9):** `serving(t)` and token expiry are wall-clock based across
   replicas and the connector. Run NTP; treat large skew as an alertable condition.
4. **Secret management (#4):** supply `Queue:HmacSecret` from a real secret manager
   (the Helm default is empty); it must match the client and Kong values.
5. **Admin API (#13):** events are configured via direct Redis writes. Before
   production, add an authenticated, audited admin endpoint.
6. **Not exercised in this environment:** the browser Playwright E2E and the Kong
   backstop's armed *runtime* Lua require the full stack; here we verified the
   cross-language token interop and `kong config parse` instead. Both gates ship
   **disarmed by default** — arm only after a live-stack verification.

## Scope note

This hardening covers the waiting room only. It assumes the surrounding platform's
existing controls (Kong JWT auth on mutations, TLS termination, network policy) remain
in force; the waiting room is an additive front-gate, not a replacement for them.
