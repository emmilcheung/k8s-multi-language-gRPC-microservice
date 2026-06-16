# Virtual Waiting Room — Design

> **Status:** Draft for review · 2026-06-16
> **Complements:** [`2026-06-09-multi-instance-read-cache-design.md`](2026-06-09-multi-instance-read-cache-design.md).
> The read path is already absorbed by the shared-Redis SWR cache + ISR + CDN
> (Mongo query opcounters stay flat under load — see
> [`docs/18-slos-and-load-testing.md`](../../18-slos-and-load-testing.md)). This
> design gates the **write path** (reservation CAS + order saga) during scheduled
> onsales, which is the genuine throughput bottleneck.

## 1. Problem & goal

A scheduled high-demand onsale (the "Taylor Swift" scenario) produces a traffic
spike that the reservation/checkout path cannot absorb at arrival rate. We need a
self-hosted, vendor-neutral virtual waiting room that:

- meters traffic into the site at a controlled rate during an armed onsale,
- tolerates extreme arrival spikes without scaling the protected origin,
- is fully testable locally (no cloud-only primitives), and
- is fair to genuine visitors and resistant to refresh/speed gaming.

It mirrors the behavior of commercial products (Queue-it, AWS Virtual Waiting
Room, Cloudflare Waiting Room) — a separate-domain waiting page, redirect-based
flow, cacheable access credential, a grace buffer, and rate-based admission — but
is built entirely from portable components we already run.

## 2. Non-goals (v1)

- Production hosting / CDN selection for the queue cluster (deferred by decision).
- Sophisticated bot management against distributed botnets (commercial products
  pair with dedicated bot managers; out of scope).
- Kafka-driven completion-release of slots (time-based reclaim is sufficient; this
  is a later optimization).
- Single-use admission tokens (nonce tracking); tokens are valid until expiry.
- Multi-event admin UI; v1 configures one event via a protected endpoint/env.

## 3. Architecture overview

Three parts: the **connector** (lives in existing repos), the **queue-service**
(new, isolated), and a **shared HMAC secret** binding them.

```
            armed onsale; sale opens at T0
 Buyer ─GET /tickets/X─▶ [CDN] ─▶ [Next.js middleware = the connector]
                                       │ gate armed & no valid pass cookie
                                       ▼ 302
        queue.example.com  ──  ASP.NET Core 10 (Razor Pages + Minimal API)
          pre-queue (t<T0): render countdown, drop random score r into ZSET
          at/after T0:       freeze position once (ZRANK) → signed ticket
          steady state:      client polls cached /serving  (CDN ~1s)
                                       │  position < serving(t) ?
                                       ▼ yes → /claim → signed admission token
                          302 back → main: /tickets/X?qpass=<token>
 [Next.js middleware] verify HMAC → set access cookie (main domain) → clean URL → through
                                       │
 reserve mutation ─▶ [Kong] ─ backstop: validate same cookie HMAC ─▶ ticket-service
```

The queue-service runs on its own subdomain with its own pods and its own Redis,
so the waiting room never competes with the main app for resources.

## 4. Admission model — rate-based, by pure calculation

Admission is a deterministic function of wall-clock time. There is **no stateful
counter to advance, no leader election, and no ticker**:

```
serving(t) = floor( λ · max(0, t − T0) )      // λ = admitted users / second
admitted(position)  ⟺  position < serving(t)
estimated_wait      =  (position − serving(t)) / λ
```

Every replica derives `serving(t)` from `(T0, λ)` alone. The `/serving` endpoint
returns a single integer, identical for all callers, and is therefore
**CDN-cacheable for ~1s** — unlimited polling costs ≈ zero backend work.

Capacity sizing follows Little's Law: to hold `L` concurrent buyers when a
transaction takes `W` seconds, set `λ = L / W`.

The only Redis **writes** in the system are one `ZADD` per pre-queuer (before T0)
and one `INCR` per latecomer. Dynamic throttling (ops changing λ mid-onsale) is a
later extension expressed as a small piecewise list of `(t, λ)` segments; v1 uses
a constant λ.

## 5. Fairness — pre-queue → randomized draw → FIFO

Randomization matters only for a scheduled start, where strict FIFO degenerates
into a millisecond land-grab won by the fastest connection or a bot. The raffle
falls out of one mechanic: **the pre-queue is a Redis sorted set scored by a
random number assigned at join.**

- **Before T0 (pre-queue):** each new browser is assigned a random 64-bit score
  `r`; `ZADD prequeue:E r mid`. The set is already a uniformly random permutation,
  so reading it in score order *is* the raffle. Arriving early or fast buys
  nothing.
- **At/after T0:** the set is frozen. A user's position is `ZRANK(prequeue:E, mid)`,
  computed **once** and baked into their signed ticket so it is never recomputed.
- **Latecomers (joined after T0):** position = `|prequeue:E|` + `INCR latecomer:E`
  — strict FIFO behind the raffle winners.

## 6. Token & cookie contract

All three artifacts are signed `HMAC-SHA256` over the payload, encoded as
`base64url(payload) + "." + base64url(hmac)`, using a shared secret held by the
queue-service, the Next.js middleware, and the Kong backstop.

| Artifact | Where | Payload fields | Purpose |
|---|---|---|---|
| **Pre-queue ticket** | cookie on **queue** domain (httpOnly) | `eid, mid (uuid), r, pos (once frozen), phase, iat` | recognizes a returning browser → position survives a browser close |
| **Admission token** | `?qpass=` query param on redirect back | `eid, mid, iat, exp (= iat + 10m), nonce` | cross-domain handoff + cacheable "access code" |
| **Access cookie** | cookie on **main** domain (httpOnly), set by middleware | `eid, mid, exp` | site access; absolute TTL + sliding idle grace |

The cross-domain split is mandatory: the queue domain cannot set a cookie on the
main domain, so the credential rides the query string on the redirect, and the
main-domain connector mints the cookie and strips `qpass` with a clean redirect.

## 7. End-to-end request flow

1. Buyer hits the main site → middleware sees the gate armed and no access cookie
   → **302** to `queue/wait?e=E&target=<original-url>`.
2. Pre-queue: server-rendered countdown page; the browser receives a pre-queue
   ticket (random `r` added to the ZSET). Closing the tab is safe — the ticket
   cookie and the ZSET pin the place.
3. At T0: the first poll freezes `pos` (`ZRANK`) into the ticket.
4. Steady state: a ~30-line vanilla-JS poller fetches the **cached** `/serving`
   integer and computes `pos < serving(t)` and the wait estimate client-side.
5. Admitted → `POST /claim` returns a signed admission token → the page redirects
   to `main/tickets/X?qpass=<token>`.
6. Middleware verifies the HMAC, sets the access cookie (absolute 10m + 60s sliding
   idle grace), clean-redirects to strip `qpass`, and lets the request through.
   Subsequent requests pass on the cookie alone — no further queue contact.
7. The reserve mutation hits Kong, whose backstop re-validates the same signed
   cookie. A script that bypasses the page still hits this wall.

## 8. Queue-service (ASP.NET Core 10, single app)

- **Runtime:** .NET 10 (LTS, supported through Nov 2028), C# 14.
- **Razor Pages** render `/wait` (countdown / position) entirely server-side; the
  only client JS is a small vanilla poller (countdown tick + fetch `/serving` +
  redirect on admit). No npm, no bundler, no client framework.
- **Minimal APIs:** `POST /api/enqueue` (mint identity + ticket), `GET /api/serving?e=E`
  (the cacheable integer), `GET /api/status` and `POST /api/claim` (ticket-cookie
  auth; freeze `pos`, issue admission token), `GET /healthz` + `/readyz`, protected
  `POST /api/admin/events` (set `T0, λ, TTLs, armed`).
- **No admission BackgroundService** — admission is pure time-math. An optional
  small janitor cleans up expired-event keys.
- **Redis keys:** `prequeue:E` (ZSET, score = random), `latecomer:E` (int),
  `event:E:cfg` (hash: `t0, rate, armed, ttls`).
- **Dependencies:** `StackExchange.Redis` only. HMAC (`System.Security.Cryptography`),
  JSON (`System.Text.Json`), health checks, and config validation
  (`IOptions` + `ValidateOnStart()`, fail-loud at startup) are all in the BCL.
- **Docker:** multi-stage `mcr.microsoft.com/dotnet/sdk:10.0` →
  `mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled` (distroless-like, non-root
  `app` user), digest-pinned, Trivy-scanned. Native AOT is not used (incompatible
  with Razor Pages view compilation; no real gain at this size).

## 9. Connector (Next.js middleware + Kong backstop)

- **Next.js middleware** (`middleware.ts`, portable to any Node host): reads the
  gate-armed flag (env/edge config); validates the access cookie with Web Crypto
  `crypto.subtle` HMAC; handles `?qpass=` (verify → set cookie → clean redirect);
  otherwise 302s to the queue. Refreshes the sliding grace on each pass.
- **Kong backstop:** a Lua `pre-function` on the reserve route validating the same
  cookie HMAC — an unskippable API-side guard against page bypass.

## 10. Deployment topology & the arm/disarm toggle

- **Local (dev):** a separate Compose group `queue/docker-compose.yml` —
  `queue-service` (page + API on host `:4100`) and its own `queue-redis`
  (host `:6390`). The main Next.js app receives `QUEUE_URL`, `QUEUE_HMAC_SECRET`,
  `GATE_ARMED`, `GATE_EVENT_ID`. Genuinely separate resources.
- **Kubernetes:** a separate cluster/namespace `queue-system` — N stateless
  ASP.NET replicas (all share Redis; safe because admission is time-math), a
  Service, its own Redis, and an Ingress on `queue.<domain>`.
- **Arm/disarm:** one logical "armed" state, materialized in two fast-readable
  places so neither side calls the other per request — the connector's own
  env/edge config and the queue-service's `event:E:cfg.armed`. The arm operation
  flips both together. The connector reads only its local config (off →
  pass-through; on → enforce); it never reaches into the queue-service's Redis.
  This is the gateway-level toggle.

## 11. Requirements traceability

| # | Requirement | Mechanism |
|---|---|---|
| 1 | Separate domain, no shared resources | own subdomain, own pods, own Redis, own Compose group |
| 2 | Redirect-based navigation | 302 out to the queue, 302 back with `qpass` |
| 3 | Cache the access code; don't force an open tab while waiting | durable pre-queue ticket (place survives close) + cacheable admission token |
| 4 | Grace buffer after access | access cookie: absolute 10m + 60s sliding idle grace |
| 5 | Tolerate extreme traffic by calculation | `serving(t)=λ·(t−T0)`, CDN-cached single integer, position baked into the ticket, O(1) writes |

## 12. Risks & open questions

- **Token sharing/replay:** a leaked `qpass` is reusable until `exp` (10m). v1
  accepts this; single-use nonce tracking (Redis `SETNX`) is a documented
  hardening.
- **Bot entries:** one queue identity per browser cookie; `/enqueue` is IP
  rate-limited at the queue domain; randomization removes the speed advantage.
  Distributed botnets need dedicated bot management (out of scope v1).
- **Pre-queue memory:** the ZSET holds one small member per pre-queuer — bounded
  and acceptable, but worth a back-of-envelope cap for the largest expected onsale.
- **Clock skew:** `serving(t)` depends on server wall-clock; replicas must run NTP.
  Token `iat/exp` validation tolerates small skew.
- **Latecomer position vs frozen pre-queue size:** `|prequeue:E|` must be read
  exactly at/after T0 freeze; define the freeze as "first request observing
  `now ≥ T0`" and cache `ZCARD` into `event:E:cfg`.

## 13. Testing strategy

- **Unit (.NET):** HMAC sign/verify round-trip and tamper rejection; `serving(t)`
  math; `ZRANK` → position freeze; latecomer ordering.
- **Integration:** bring up the Compose group → enqueue → advance time/λ → assert
  the admit boundary; assert expired and forged tokens are rejected.
- **E2E (Playwright):** armed gate redirects to `/wait`; after admit, `qpass` sets
  the cookie and lands on the ticket page; a disarmed gate passes straight through.
- **Load (k6):** extend `load/k6/onsale-read.js` — thousands polling `/serving`
  must stay flat (CDN-absorbed); assert queue-service origin load stays ~constant
  regardless of poller count.

## 14. References

- Queue-it — [How it works](https://queue-it.com/developers/how-queue-it-works/),
  [FIFO vs randomization](https://queue-it.com/blog/first-in-first-out-randomization/),
  [Pre-queue](https://queue-it.com/pre-queue/),
  [Rate-based queuing](https://queue-it.com/blog/rate-based-queuing/).
- AWS — [Virtual Waiting Room: how it works](https://docs.aws.amazon.com/solutions/latest/virtual-waiting-room-on-aws/how-the-solution-works.html),
  [design considerations](https://docs.aws.amazon.com/solutions/latest/aws-virtual-waiting-room/design-considerations.html).
- Cloudflare — [Waiting Room settings/analytics](https://blog.cloudflare.com/understand-the-impact-of-your-waiting-rooms-settings-with-waiting-room-analytics/).
- .NET — [.NET 10 release notes](https://github.com/dotnet/core/blob/main/release-notes/10.0/README.md),
  [.NET 10 container images](https://github.com/dotnet/dotnet-docker/discussions/6801),
  [Blazor Server hosting/scale](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/server/?view=aspnetcore-10.0).
