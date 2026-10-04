# Session Progress Log

> Append a new entry each session. Newest entry at the top.
> **History policy:** keep the current quarter in full. At the start of each new quarter,
> condense older entries into [Earlier milestones](#earlier-milestones-condensed): what
> landed, the decisions and why, the lessons worth keeping, and what is still open. The
> full original text stays in git history. The last full version before condensing is
> `git show 9afd4c6:docs/16-session-progress-log.md`; the old 2026 Q1 archive file is
> `git show a03c72e1^:docs/log/archive/2026-Q1.md`. Last condensed on **2026-10-04**
> (Q1–Q3 2026).

---

## Session: 2026-10-04 — Per-buyer seat limit for seated events, behind a flag ⏳ IN PR (#159)

On `feat/seated-per-user-cap`. A seated plan had no per-buyer limit: one account could hold
or reserve every seat by splitting the purchase over several calls. The GA path already
enforced the ticket's `maxPerUser` in ticket-service.

- **venue-service**: with `SEATED_CAP_ENFORCED=true`, holds (REST and GraphQL) and both
  reserve RPCs read the ticket's `maxPerUser` from ticket-service `GetTicket` (no copy of
  the limit is stored in venue). Every seat the buyer has on the plan is counted once:
  live holds, the seats asked for, and seats in RESERVED or SOLD reservations. Same-buyer
  requests on a plan are serialised with a transaction advisory lock taken before the seat
  row locks, so parallel requests cannot each pass the count. ticket-service stores a
  limit of 0 as 1, so every ticket has a limit. Over the limit: REST hold 409, GraphQL `conflict:`, gRPC `FAILED_PRECONDITION`
  "per-buyer seat limit reached". Holds keep each ticket's limit for a minute and use the
  last known one while ticket-service is down; only a ticket never read before refuses the
  hold (503). Migration `006` adds a partial index `seats (held_by, plan_id) WHERE status =
  'HELD'` for the count (checked with EXPLAIN; recovery steps in venue `AGENTS.md`). The
  flag is in the Helm chart, set to `"false"`.
- **Seats from another plan are refused**: the hold and reserve seat locks now also match
  `plan_id`. Before, a request naming plan A could hold or reserve plan B's seats, which
  skipped plan B's checks and, with the limit on, counted zero seats each time. This
  applies with the flag off too.
- **order-service**: venue's limit answer maps to 422 "Purchase limit exceeded for this
  ticket", the same message as the GA limit.

Default is off: ticket-service defaults `maxPerUser` to 1, so existing seated tickets must
be audited before the flag is turned on. `seating_plans.max_seats_per_order` exists but is
still not enforced anywhere.

## Session: 2026-10-04 — Refund paid orders that cannot be fulfilled ✅ MERGED (PR #156)

On `fix/unfulfillable-order-refund`. A payment captured after its order expired, or
after its seats were released, used to leave the order CANCELLED with the money kept.
Now the buyer is refunded automatically.

- **order-service**: `markComplete` locks the order row and finalizes the reservation
  *before* marking COMPLETE. When the order is already cancelled, or venue/ticket
  service reports the reservation released or unknown, the order ends CANCELLED with
  `cancelReason = UNFULFILLABLE_REFUNDED` and emits `orders.order.unfulfillable`. Any
  other gRPC failure is rethrown, so Kafka retries and then dead-letters — an outage
  is never treated as proof the seats are gone. Orders now record why they were
  cancelled (`cancel_reason`, migration V9), exposed as `Order.cancelReason` in GraphQL.
- **payment-service**: refunds are a work queue. A refund request writes a REQUESTED
  row; `RefundExecutorService` claims due rows with `FOR UPDATE SKIP LOCKED`, calls the
  refund provider with a stable idempotency key, and retries with backoff (5 attempts)
  before marking FAILED and emitting `payments.refund.failed`. The payment only becomes
  REFUNDED after the provider confirms. A unique partial index allows one live refund
  per order, so redelivered events cannot refund twice (migration 007).
- **Refund provider**: `REFUND_PROVIDER=simulated` (default) moves no money and makes no
  network call; `stripe` calls `refunds.create`. A live Stripe key is refused at startup
  unless `REFUND_ALLOW_LIVE=true`.
- **Topics**: `orders.order.unfulfillable` (+ `.dlq`), `payments.refund.completed` and
  `payments.refund.failed` added to `infra/helm/files/topics.yaml`. New topics only — no
  existing topic's settings change.

Known gap: if finalize succeeds and the order's commit then fails for a non-concurrency
reason, an expiry landing before the Kafka retry leaves the seats sold with no complete
order; the buyer is still refunded. Customer notification of the refund is out of scope.

---

## Session: 2026-10-04 — Seat-sale correctness in venue-service ✅ MERGED (PR #155)

On `fix/seat-sale-correctness`. First of two ticket-rush PRs (PR #156 above was the second).

- **Expired holds free up immediately.** The Redis hold script treated a seat in the held
  state as taken even after its hold marker had expired, so abandoned holds blocked seats
  until the 30 s sweeper ran, and Redis kept refusing them after it. A held or reserved
  seat now blocks only while its marker key exists; sold seats always block. PostgreSQL
  `HoldSeats` also takes over holds whose `held_until` has passed.
- **Redis follows reservations.** `hold.RedisSyncedReservations` wraps the reservation
  repository: reserve → reserved with a marker that expires with the reservation,
  finalize → sold, release → free (only when this call actually ended the reservation,
  so a redelivered release cannot wipe a newer hold). Redis failures are logged, never
  returned — PostgreSQL stays authoritative. Release can no longer free reserved or sold
  seats.
- **Hold ownership on order.** `AtomicReserveAndCreate` accepted any held seat, so one
  user could order seats another user was holding. It now accepts only seats that are
  free, held by the ordering user, or held by an expired hold. A refusal reuses the
  existing seats-unavailable response (order-service maps it to 409); no proto change.

Verified by `test/hold_redis_integration_test.go` (miniredis + Testcontainers PostgreSQL):
expiry with and without a sweep, 500 concurrent holds → exactly one winner, reserved and
sold seats stay blocked, another user's held seats cannot be ordered. The expiry and
ownership tests failed before the fix. Not done: SSE change events on sweeps.

---

## Session: 2026-10-03 — MCP platform review fixes ✅ MERGED (PR #153)

Fixes from the MCP platform review, on `feat/mcp-platform`, with no dependency or
version change (the Trivy and dependency gates are untouched).

- **Idempotency**: the derived key now includes a 15-minute window, so a cancelled or
  expired order no longer replays forever; a missing `sub` is an auth failure instead
  of falling back to the client id.
- **OAuth**: the session verifier accepts only the session issuer; disconnecting a
  client records a not-before time that blocks exchange of earlier tokens; mcp-service
  reuses an exchanged token for at most 60 seconds.
- **Config**: `API_AUDIENCE` is an explicit optional setting; Helm derives the issuer,
  resource and audience from `global.publicOrigin`, and the umbrella chart fails the
  render when mcp-service is enabled without it.
- **Observability**: Kong logs each audience-less OAuth token it admits;
  `order.keyed.uncompensated{flow}` counts keyed creates that leave a reservation held.
- **Contracts**: venue-service pins the "was already released" phrase order-service
  matches on, as ticket-service already did for its prefix.
- **Shutdown**: one SIGTERM handler in mcp-service drains connections (20 s), then
  flushes telemetry (3 s), under the 30 s pod grace period.
- **Docs**: the V8 migration pre-check and concurrent-build steps are in
  `docs/11-kubernetes-deployment.md`.
- **Disconnect and REST access**: a dynamically registered or metadata-document client is
  now limited to the MCP resource (a missing `resource` means `/mcp`, `/api` is
  `invalid_target`), because a token minted for `/api` directly bypassed the exchange and
  stayed valid for up to 15 minutes after Disconnect. The static `ticketing-mcp` client is
  unchanged and `docs/06-security.md` says so.

Left open on purpose: the queue-gate pass has no expiry or event binding (changing it
changes what an admission means after 10 minutes and must match the client gate), and
dynamic client registration still defaults to every scope (read-only defaults would stop
a client that registers without a scope from ever stepping up to `orders:create`).

---

## Session: 2026-10-02 — feat(mcp): Wave 4 — client metadata documents, end-to-end spec, MCP docs ✅ MERGED (PR #153, 2026-10-03)

**Branch:** `feat/mcp-platform-wave4` — lanes `feat/mcp-w4-{i,m}` merged `--no-ff` (I, then M), then merged `--no-ff` into the integration branch `feat/mcp-platform`. The wave and lane branches were deleted after the merge; the work is on `feat/mcp-platform`, in a PR to `main`.

**What landed**

- **WS-I (auth-service, client):** Client ID Metadata Documents. With `OAUTH_CIMD_ENABLED` on, a host may use an `https` URL as its `client_id`; auth-service fetches the JSON document behind an SSRF guard and treats it as a public, never-first-party client. The guard: strict URL shape (https, port 443, DNS name, no internal suffix, no query/fragment/userinfo), its own DNS resolution with every address checked against a block list, a connection pinned to the vetted address with TLS bound to the host name, no redirects, 200 + JSON only, 5 KB, one 3 s deadline, at most 8 fetches in flight, Redis cache (60 s – 24 h, 60 s negative). A refused document is 400 `invalid_client`; a transient failure is 503 `temporarily_unavailable` with `Retry-After`. The flag defaults to **false** and is true only in compose and `values-local.yaml`. Dynamic registration stays and now shares one validation rule with CIMD. The consent page and Settings → Connected apps show where the client's document is hosted and where the user is sent after allowing, with a caution when the two differ; the consent buttons stay disabled until the page hydrates (an early click used to be lost silently — the cause of the Wave 3 flake). Revoke gained a query form, `DELETE /oauth/clients?client_id=`, because a URL id cannot sit in a path segment.
- **WS-M (client E2E, docs, CI):** `tests/e2e/mcp-full-flow.spec.ts` plays an MCP host through Kong: discovery, dynamic registration, PKCE with `resource`, browser login and consent, `initialize`, `tools/list` (12), a read tool, `create_order` twice (second `replayed: true`), payment, and the negative edges (no token, MCP token on REST, step-up, 405 on GET/DELETE, internal-address CIMD ids refused). `docs/ticketing/mcp.md` replaces three stale stdio-era files; `docs/06-security.md` gains the MCP threat model and `docs/03-api-design.md` the two documented exceptions (mcp-service verifies its own token; it calls Kong's public REST).

**Spec deviation:** D12 said `dns.promises.lookup`; the fetcher uses `dns.promises.Resolver` (c-ares) instead, so a slow lookup cannot occupy the libuv thread pool that password hashing shares, and can be cancelled at the deadline. Still node built-ins, no dependency.

**Behaviour change for integrators (dynamic registration):** redirect URIs with a fragment (even an empty `#`) or userinfo are now refused, as are non-http(s) schemes on loopback hosts; `client_name` is limited to 100 characters with no control or formatting characters (which also rejects emoji joined by a zero-width joiner).

**Exit gate (wave branch `110924f`, then three post-gate fixes re-checked on `5a399c6`): PASS WITH NOTES.** Static: auth-service 464 unit / 25 integration, lint 0 errors; client 244 unit (2 skipped: `queue-gate.integration`, needs `QUEUE_REAL_TOKEN`, untouched here); mcp-service 127. The two real-socket CIMD specs ran 5 × clean (OpenSSL 3). `OAUTH_CIMD_ENABLED` is true only in compose and `values-local.yaml`; no NetworkPolicy, `package.json` or lockfile changed. Live through Kong on a compose stack: `mcp-full-flow.spec.ts` 13/13 three times without retries, `oauth-agent-boundaries` 13/13, `connected-apps` 1/1, the ticketing consent test 1/1. In a real browser: the consent page shows the redirect destination ("an app on this device" for loopback), wraps an 84-character host at 375 px, and its buttons are `disabled` in the server HTML and enabled after hydration with no console warnings; Revoke sends `DELETE /oauth/clients?client_id=` → 204 and the old refresh token then fails. Dynamic registration refuses the listed bad redirect URIs and names and accepts the good ones. CIMD: metadata advertises support; six internal or malformed URL ids are refused with 400 in ~3 ms and no outbound request; one real fetch (`example.com`, a 404) is refused, logged with host and reason only, and answered from the negative cache on repeat.

**Fixed after the gate:** the consent "Application" block squeezed the new address lines beside the client-id chip and clipped the chip at 375 px (now stacked, re-checked in a browser at 375 px and desktop); a URL client id refused before any fetch left no log line (now `oauth.cimd.url_rejected` / `oauth.cimd.busy`, reason and host only).

**Not verified:** a successful fetch of a valid public metadata document; the consent page for a CIMD client in a browser (document-host line and mismatch caution are unit-tested only); the 503 `temporarily_unavailable` path live; the transport spec under LibreSSL; the full umbrella `helm template` (only the auth-service chart was rendered: flag present for local, absent for staging and prod); the edited `e2e` CI job on a runner; any cluster deploy.

**Owner items**

- **Hard stop #10 — egress for CIMD.** Enabling `OAUTH_CIMD_ENABLED` in any cluster needs an auth-service egress NetworkPolicy (TCP 443 to the public internet excluding private ranges, plus DNS). None exists and none was written; staging and prod keep the flag off. `/oauth/authorize` is unauthenticated, so with the flag on anyone can make auth-service fetch a public URL of their choice (bounded by the Kong per-IP limit, the caches and the in-flight cap).
- **Refresh tokens (pre-existing, now documented):** no reuse detection; rotation is read-then-write, so two concurrent refreshes can both succeed; the 24 h lifetime is sliding, so a stolen refresh token used daily works until the user revokes. Decide whether to fix (atomic rotation + family revocation on reuse, absolute lifetime) before any public exposure.
- **Dynamic registration:** no cap or quota beyond the per-IP limit and the one-year key expiry.
- **auth-service request log (pre-existing):** the pino-http line logs the request URL with its query string on every route, so the whole `/oauth/authorize` URL (client id, redirect URI, `state`, PKCE challenge) and the email on `GET` lookups land in the access log. No token or client secret travels in a query string on the OAuth routes. Decide whether to strip or redact the query.
- **`/oauth/authorize` errors (pre-existing):** a 4xx is the general error envelope with the OAuth error as a string inside it, shown raw to the browser. A human-readable error page is not built.
- **`MaxListenersExceededWarning`** (11 `finish` listeners on the response) appears in auth-service logs per request. This wave changed no auth-service source outside `modules/oauth` and no dependency, so it is not from here; not traced.
- **Manual check with a real host: run after the gate** (Claude Code 2.1.285, compose stack). The host connected with its `claude.ai` metadata-document client id, so this also covered a successful fetch of a valid public document and the consent page for a CIMD client in a browser, both listed above as not verified. Twelve tools visible; `create_order` twice gave one order (`replayed: true`); revoke forced a new sign-in once the 15-minute token expired. Result and what was left out are in `docs/ticketing/mcp.md`.
- **CI:** the `e2e` job now needs the `mcp` job, starts mcp-service (`COMPOSE_PROFILES: mcp`) and generates a throwaway exchange secret on the runner. Not run on a runner: watch the 20-minute limit on the first PR, and confirm `secrets.STRIPE_SECRET_KEY` contains `test_mock`. `audit/scripts/scrub-secrets.sh` does not know `TOKEN_EXCHANGE` names.
- **Left for WS-N (stdio retirement, needs the owner's date):** `packages/ticketing-mcp-server`, the static `ticketing-mcp` client, `.mcp.json`, and the stdio parts of `docs/diagrams/05-auth-flows.*`.

Ledger: `.superpowers/sdd/2026-10-02-mcp-wave4/` (`exit-gate.md`, per-lane reports, reviews and rulings).

---

## Session: 2026-10-02 — feat(mcp): Wave 3 — token exchange, MCP tools, consent UI, Kong `/mcp` ✅ MERGED (PR #153, 2026-10-03)

**Branch:** `feat/mcp-platform-wave3` — lanes `feat/mcp-w3-{l,h,j,k}` merged `--no-ff` (L → H → J, then K on top), then merged `--no-ff` into the integration branch `feat/mcp-platform`. The wave and lane branches were deleted after the merge.

**What landed**

- **WS-H (auth-service):** RFC 8693 token exchange at `POST /oauth/token` for one confidential client, `mcp-service` (`client_secret_basic`). The secret is stored as a SHA-256 hex digest (`MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH`) and compared in constant time; unset disables the grant with a warning, malformed fails startup. The exchanged token carries the API audience, `act: {sub: mcp-service}`, and never outlives the subject token (`exp = min(iat + 300, subject.exp)`). Audit event `oauth.token.exchanged`. `GET /oauth/clients` returns the registered client name.
- **WS-J (mcp-service):** the 12 tools of contract C-7, each calling Kong's public REST with an exchanged token (no passthrough). Exchange results are cached per (token hash, scope); a derived `Idempotency-Key` makes create tools safe to retry and reports `replayed`; a missing scope returns the C-6 step-up challenge. `search_events` has no free-text query or paging because ticket-service REST offers neither (owner item below).
- **WS-L (client):** consent page shows the registered client name and per-scope descriptions from `GET /oauth/scopes`, with a Sensitive marker; an unknown scope fails closed. Settings → Connected apps lists and revokes grants.
- **WS-K (kong-gateway):** routes `/mcp` and `/.well-known/oauth-protected-resource/mcp` → mcp-service with no Kong jwt plugin (mcp-service verifies its own audience-bound token), identity headers cleared, per-IP limit. A second `jwt_secret` keyed on the OAuth issuer origin, and the **REST audience rule (C-10)** in `jwt-scope.lua`: an OAuth token whose `aud` is not `<issuer>/api` is refused 401, so an MCP-audience token cannot be replayed against REST. New fail-loud build input `KONG_OAUTH_ISSUER` (dev/staging/prod). `OAUTH_ISSUER_ENABLED` is now `true` in compose and `values-local.yaml`; staging/prod keep the schema default (false). New `scripts/test-jwt-scope.sh` runs the real Lua under `resty`; the Kong CI job now runs it and `test-build-lint.sh` (previously run by nothing).

**Spec amendment:** C-7 — `pay_for_order_with_default` needs `payments:read` in addition to `payments:create`.

**Exit gate (wave branch `530decf`): PASS WITH NOTES.** Static: auth-service 234 unit / 25 integration; mcp-service 127 tests, image non-root; client 227 unit; Kong build + validate for local, minikube, dev, staging, prod, `test-build-lint.sh` 18/18, `test-jwt-scope.sh` 15 cases; umbrella chart renders with mcp-service enabled. Live through Kong on a compose stack: discovery documents agree on issuer and resource; `/mcp` without a token → 401 with `resource_metadata`; dynamic registration + authorization-code/PKCE → `tools/list` returns 12 tools and read tools succeed via the live exchange; `create_order` twice → second call `replayed: true`, one order upstream; missing `orders:create` → 403 `insufficient_scope`; MCP-audience token on `GET /api/orders` → 401, browser token → 200, OAuth token on `/graphql` → 403, forged `X-User-*` on `/mcp` → 401; refresh after revoke → `invalid_grant`; consent and Connected apps verified in Chromium; `oauth-agent-boundaries.spec.ts` + `connected-apps.spec.ts` 14/14.

**Not verified:** the consent page's unknown-scope branch live (auth-service drops unknown scopes at registration; unit tests only); `/mcp` 429 and the Redis rate-limit policy; payment tools, `create_seated_order`, `cancel_order` and the waiting-room mapping against a live stack; any cluster deploy (helm render only); the new CI step on a real runner. One Playwright flake on a cold `next dev` (consent POST hung once, not reproduced in three re-runs).

**Accepted behaviour:** revoking an app blocks refresh immediately, but an MCP access token already issued stays exchangeable until it expires (≤ 15 min).

**Owner items**

- Hard stop #10 review of the new public Kong routes: `POST|GET|DELETE /mcp`, `GET /.well-known/oauth-protected-resource/mcp`, `GET /oauth/scopes`. Tuning points: `/mcp` is limited per source IP (600/min), which hosted MCP clients on shared egress IPs would share; no CORS/OPTIONS on `/mcp` (browser-based MCP clients would need it).
- Deploy pipelines for dev/staging/prod must set `KONG_OAUTH_ISSUER` to the same origin as Helm `global.publicOrigin`; the audience rule applies even while `OAUTH_ISSUER_ENABLED` is false, so a mismatch 401s every OAuth REST call.
- Add `MCP_TOKEN_EXCHANGE_CLIENT_SECRET` and `MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH` (SHA-256 hex of the secret; generator in `.env.example`) to the local `.env` and `infra/local/secrets.env`; decide whether mcp-service leaves the opt-in `mcp` compose profile.
- ticket-service REST needs a search parameter and a returned next cursor before `search_events` can search or page.
- `.github/workflows/ci.yml` (Kong job) was edited by this wave: a stand-in `KONG_OAUTH_ISSUER` and one test step.

Ledger: `.superpowers/sdd/2026-10-02-mcp-wave3/` (`exit-gate.md`, per-lane reports and reviews).

---

## Session: 2026-10-02 — feat(mcp): Wave 2 — AS metadata, order idempotency, mcp-service scaffold ✅ MERGED (PR #153, 2026-10-03)

**Branch:** `feat/mcp-platform-wave2` — lanes `feat/mcp-w2-{e,f,g}` merged `--no-ff` (E → F → G), then merged `--no-ff` into the integration branch `feat/mcp-platform`. All MCP branches were rebased onto `main` `04307ee` first (integration with `--rebase-merges`). The wave and lane branches were deleted after the merge.

**What landed**

- **WS-E (auth-service):** RFC 8414 metadata at `/.well-known/oauth-authorization-server` (public Kong route `auth-as-metadata`), `/oauth/scopes`, scope registry, RFC 8707 `resource` → `aud`, loopback redirect matching (RFC 8252 §7.3). The four `OAUTH_*` URLs derive from one Helm value, `global.publicOrigin`; unset in production, auth-service refuses to start and names the value. Production rejects http / loopback / fragment issuer and resource URLs. Refresh validates `resource` before rotating.
- **WS-F (order-service, ticket-service, venue-service):** `Idempotency-Key` on `POST /api/orders` and `/api/orders/seated` (V8 migration: `request_fingerprint`, unique `reservation_id`). A keyed create never compensates on failure — the reservation is shared across retries, so releasing it could strand a sibling's committed order; expiry reclaims it instead (worst case ~21 min). ticket-service accepts a duplicate reserve only while RESERVED. **venue-service gained a reservation expiry sweep** (it stored `expires_at` and never acted on it), and release/finalize on an EXPIRED reservation are now safe.
- **WS-G (mcp-service):** new resource-server scaffold — RS256-only bearer verification against the auth-service JWKS, RFC 9728 protected-resource metadata, 401 challenge, non-root image, Helm chart (disabled by default) with NetworkPolicy, compose `mcp` profile, CI job.

**Exit gate (merged branch):** auth-service 177 unit / 25 integration; order-service checkstyle + 97 unit / 19 IT; ticket-service and venue-service `go vet` + `go test`; mcp-service 20 tests, image runs as uid 100; Kong `test-build-lint.sh` 10/10, local/staging/prod build + validate, guards SCOPE 11 / DENY 17. Umbrella chart renders the four `OAUTH_*` vars for local and when `publicOrigin` is set, none when unset. Through Kong on freshly built auth/order/ticket/venue/kong/mcp images: metadata issuer `http://localhost:8000`, `oauth-agent-boundaries.spec.ts` 13/13, live idempotency check 201 → 200 `Idempotent-Replayed: true` (same id) → 422 on a changed body.

**Not verified:** the `mcp` compose profile (the secret is not in the local `.env`; the image was run standalone instead and token exchange was not exercised); payment/user/attendance/expiration images were not rebuilt; multi-replica sweep contention; any deploy.

**Owner items**

- Set `global.publicOrigin` (public https origin) in `values-staging.yaml` and `values-prod.yaml` before deploying — auth-service will not start without it.
- Hard stop #10 review: Kong public route `auth-as-metadata`; mcp-service NetworkPolicy (ingress Kong:3000; egress DNS 53 to any, Kong 8000, auth-service 3000, otel-collector 4317; podSelector-only).
- Hard stop #9: mcp-service dependencies, incl. `@modelcontextprotocol/client` 2.2.0 (devDependency, test-only).
- Add `MCP_TOKEN_EXCHANGE_CLIENT_SECRET` to the local `.env`; run the V8 duplicate pre-check in non-local environments.
- Acknowledge two known P0s the new venue sweep touches (tracked separately, not fixed here): a seat freed by a DB-only release stays un-holdable on the Redis manual-pick path; a seated order paid after its reservation expired now fails to finalize, as GA already does. *Both since fixed: PR #155 keeps Redis in step with reservations, and PR #156 refunds a paid order that cannot be finalized.*

Ledger: `.superpowers/sdd/2026-09-30-mcp-wave2/`.

---

## Earlier milestones (condensed)

Short versions of the 2026 Q1–Q3 entries. They are grouped by theme, newest first. Each
one keeps what landed, why, the lessons worth reusing, and what was still open. Items in
the "Still open" lists were open when the work ended. Check the code or the open PRs
before you rely on one.

### 2026 Q3 (Jul–Sep)

#### MCP platform, Wave 1 — OAuth boundaries (2026-09-29/30, shipped in PR #153)

- **Invariant pinned:** OAuth grants and browser sessions never turn into each other.
  Three regression tests in `services/client/tests/e2e/oauth-agent-boundaries.spec.ts`
  check this. An OAuth access token is not a session at `/oauth/authorize`. An OAuth
  refresh token cannot mint a browser session. A browser refresh token is refused at
  `/oauth/token` in RFC error shape.
- **Owner decision (legacy refresh sessions):** a refresh session from before the deploy
  falls back on a legacy scope marker (`RefreshTokenService.resolveOAuthClientId`). For
  up to 7 days after deploy it can look like a browser session. The owner accepted that
  window. The fallback is to be removed at deploy + 7 days, as part of the stdio
  retirement. Force-logging-out every untagged session was rejected as bad UX.
- **Still open:** the queue-gate pass is checked by HMAC only, with no expiry, event or
  single-use binding (`services/kong-gateway/plugins/queue-gate.lua`). The ticket-rush
  plan's login-to-claim bound pass covers this. The seating-plan lifecycle E2E
  (`ticketing.spec.ts`, "Deactivate Plan") is flaky. The test clicks right after a
  `domcontentloaded` reload, before hydration, so the click does nothing.

#### Agent instruction-surface audit (2026-09-29)

- Fixed drift in the agent docs:
  - the `end-to-end-check` skill path is now `tests/`;
  - `lint-check` now names `ci.yml` as its source of truth and includes golangci-lint, attendance, queue and buf;
  - CLAUDE.md Rule 6's token limits, which nothing could meet, became "keep context lean";
  - the hard-stop count is corrected;
  - orchestration docs describe roles rather than pinned model versions;
  - worker templates forbid invoking skills and writing plans.
- **Still open:**
  - `SUBAGENT_ORCHESTRATION.md` still carries the April batch history as if it were current;
  - CLAUDE.md Rule 5 talks about LLM calls this repo does not make;
  - the `AGENTS.md` "Last Updated" date is stale.

#### Scalability follow-ups — registry, queue keys, order expiry backstop (2026-09-29, PRs #145–#148)

- **Image registry:** first-party charts read `global.serviceImageRegistry`, and
  `global.imageRegistry` is pinned to `""`. Bitnami subcharts therefore keep pulling
  from docker.io. Before this, the placeholder registry broke the whole
  `helm template` run as soon as any Bitnami subchart was enabled.
- **queue-service Redis keys:**
  - Every Redis key for an event shares the `{eventId}` hash tag, so multi-key scripts are Redis Cluster safe. A CRC16 oracle test pins this.
  - Images are pinned, and the no-`latest` CI guard covers `infra/queue-system`.
  - The single-writer Redis uses `Recreate`.
  - **Rollout note:** the key rename orphans queue state already in Redis, so do not deploy it during an on-sale.
- **Order expiry backstop:**
  - `OrderExpirySweepJob` expires `CREATED`/`AWAITING_PAYMENT` orders past `expires_at` plus a grace period, for orders whose expiration-service job was lost.
  - Defaults: 300 s grace, 200 per batch, every 60 s, set with `ORDER_EXPIRY_SWEEP_*`.
  - It uses one transaction per order. `@Version` makes races between replicas safe.
  - `V7` adds a partial index, and an EXPLAIN test pins its use. A plain `CREATE INDEX` takes a SHARE lock, so apply V7 outside an on-sale.
- **CI lesson (#148):** the GHA buildx cache keys on the FROM digest plus the RUN text.
  An `apt-get upgrade` layer therefore stays stale until the base digest is bumped.
  Fresh Debian openssl/tzdata fixes did not reach the image until the `bookworm-slim`
  digests were bumped.
- **Still open:** a daily cache-bust build-arg. None of these three items is deploy-verified.
- PR #149 recorded these merges separately. Its content now lives here.

#### Scalability M3 — connection budget, HPA signals, zone spread, SSE scale-in (2026-09-23, PR #150, partial)

- **Connection budget:**
  - Every service sets its pool explicitly from `DB_POOL_MAX`. The arithmetic is in the Connection Budget section of [`docs/05-data-conventions.md`](05-data-conventions.md): PostgreSQL's default of 100, an 80 % rule, and pool size × HPA `maxReplicas`.
  - auth was sized for 240 connections against a 100-connection server. The pods that fall over in that case are the ones that just scaled up.
  - The Node services default to 12 and read the value with `getOrThrow`, so a missing chart value cannot silently restore an over-budget pool.
- **One Mongo client per process** in ticket-service. The pool is sized, with
  `writeconcern.Majority()` and `readpref.Primary()`. A `w=` in the URI cannot downgrade
  the write concern, and a test checks this.
- **HPA signals:**
  - order-service's HPA no longer scales on memory. JVM RSS tracks high-water heap, not load.
  - metrics-server is installed (EKS managed addon; `minikube addons enable metrics-server` locally). Before this, every HPA reported `<unknown>` and never scaled.
- **Capacity:**
  - Staging and prod spread pods across zones with `whenUnsatisfiable: DoNotSchedule`, which is a hard constraint, so it needs a node autoscaler.
  - Karpenter was added in Terraform:
    - EKS Pod Identity;
    - the controller is pinned to the managed node group, because Karpenter must not run on nodes it manages;
    - on-demand only, with a 200 vCPU ceiling;
    - a one-node disruption budget and 30-day node expiry;
    - private subnets tagged `karpenter.sh/discovery`. Without the tag it provisions nothing and looks like a full cluster.
- **SSE survives scale-in (venue-service):**
  - A stream never completes, so `e.Shutdown` used to block and then cut every stream.
  - Now `Drain()` ends each stream with a jittered `retry:` (500–5000 ms) so clients do not reconnect all at once. New clients get 503 during a drain.
  - `preStop` sleeps 5 s.
  - HPA scale-down is limited to 600 s stabilisation and one pod per 120 s.
  - Every change is numbered (`INCR venue:{planId}:version`) and sent as the SSE `id`. A reconnect with `Last-Event-ID`, or a dropped buffer message, gets `event: resync`, because there is no replay log. The snapshot version is read *before* the section walk.
- **Lessons:**
  - Stale first-party `*.tgz` files next to their chart directories make umbrella renders nondeterministic. Delete them and keep only the third-party packages.
  - `terraform init -backend=false && terraform validate` works inside `infra/terraform/modules/<name>` even though the local Terraform (1.5.4) cannot validate the environments.
- **Still open:**
  - PgBouncer. It is a prerequisite for one shared RDS instance, because 380 fleet-wide connections need `max_connections` ≥ 475.
  - KEDA.
  - The N+1 read in `hold/manager.go`.
  - The client has no SSE consumer yet.
  - Nothing in M3 is deploy-verified. Its exit criterion (HPA scaling on real metrics with no connection refusals at max) needs a cluster.

#### Scalability M2 chart half — topics as code, loadable gateways, external secrets, Mongo replica set (2026-09-22, PR #142)

- **Kafka topics:**
  - Declared in `infra/helm/files/topics.yaml` and created by a `post-install,post-upgrade` hook Job. It is not `pre-*`, because locally the broker is in the same release.
  - Partition counts are sized to the largest consumer group at HPA max.
  - The Job reports drift and never corrects it. Raising partitions rehashes keys, and lowering them is impossible.
  - `autoCreateTopics` defaults to false. Auto-create had made 7 topics with 1 partition before the hook ran.
- **Kong staging/prod configs did not load at all.**
  - The `redis` rate-limit policy requires `redis.host`.
  - CI only rendered `local`. It now builds and validates all five environments, and that guard is the durable fix.
  - Fixed at the same time: missing `HOST_USERS`/`HOST_ATTENDANCE`; the ElastiCache host from `KONG_RATE_LIMIT_REDIS_HOST` (render fails without it); `redis_ssl` on.
  - Only the auth endpoints set `fault_tolerant: false`, so a Redis outage cannot switch off the brute-force limit. Every other route fails open.
  - The anonymous per-IP limit went from 60 to 600/min, because Next.js page and asset requests share the bucket. This loosens a production control and is an owner call.
- **Linkerd:** `skipOutboundPorts` is now per overlay. Staging and prod had inherited the
  local broker port 9092 while MSK listens on 9098. An overlay's `global:` block
  deep-merges into the chart default.
- **ExternalSecrets:** each chart can render one into the Secret it already names. It is
  off everywhere until the operator and its IAM role exist; turning it on early leaves pods
  with no Secret.
- **Local MongoDB is a single-member replica set**, so majority writes, transactions and change
  streams work. The arbiter is disabled, `Recreate` is removed (not valid for a
  StatefulSet), and the URI uses the pod FQDN plus `replicaSet=rs0`.
- **Lessons:**
  - `kong config parse` accepts duplicate YAML keys, and the last one wins.
  - A stray `git stash` inside a verification loop gave three false "renders clean" results. Check `git stash list`.
- **Still open (owner):**
  - **MSK client auth.** MSK is IAM-only, and no service can speak IAM: librdkafka lacks it and .NET has no option. The realistic path is SASL/SCRAM on MSK. Related: the MSK security group opens 9094 with no mechanism behind it.
  - The prod `ticketing-postgres-users` Secret is regenerated on every render, so a real `helm upgrade` would rotate the password.
  - CI never renders the umbrella chart with an overlay.
  - The leaked `X_USER_ID_SIGNING_KEY` is unrotated.
  - Apollo Router GraphOS licence vs. dropping operation limits.
  - The prod namespace.

#### Scalability M1 — safe horizontal scale-out (2026-09-16 → 09-21, PR #139)

- **Backing stores:** every Bitnami subchart has an `enabled` toggle. Staging and prod
  turn them all off (0 StatefulSets) and read connection strings from Secrets.
- **Outbox claims:** every relay claims rows with `FOR UPDATE SKIP LOCKED` (order,
  payment) or a Mongo lease (ticket). The contract is in
  [`docs/04-asynchronous-messaging.md`](04-asynchronous-messaging.md).
- **Decision: mark-published commits per batch.** Per-message commit inside a held
  `SKIP LOCKED` claim deadlocks invisibly: the inner transaction waits on the outer
  one's lock. So the per-batch trade-off is accepted and copied to the other relays.
  Revisit only on evidence: a measured duplicate rate or a long-transaction alert.
  `OutboxMessagePublisher.publishOne` must keep its `catch` inside the method. A
  Kafka failure escaping the proxy would mark the batch rollback-only and re-send all of
  it.
- **Outbox cleanup:** order-service deletes in batches (500 × up to 100 per run).
  `@Transactional` is on the repository method, so each batch commits. `V6` adds the
  mirror partial index on `published = true`.
- **Venue:** `ProvisionFromVenue` runs on one transaction, which closes a check-then-act
  race and the half-built plan a mid-loop failure used to leave. The hold sweeper takes
  `pg_try_advisory_xact_lock`, the transaction-scoped one, because a session lock
  would stick to a pooled connection.
- **Other replicas:** the ticket-service quota reconciler takes a Redis `SET NX` lease.
  expiration-service runs 2 replicas.
- **Lessons:**
  - Four tests in this milestone could not fail. A fix verified by reverting it must have the revert *executed*, and the test must be able to report the failure.
  - A concurrency test must pin its pool size (`MaxConns`), not take it from the host CPU count.
  - A test that holds a pooled connection must `defer Release()`, or a failed assertion hangs the run instead of reporting.
  - `@Transactional` on a hand-constructed object does nothing. Guard such a property with a reflection test.
- **Decided, not done:**
  - Venue lock ordering. No deadlock reproduced, and single-statement `= ANY($1)` locks in scan order. Reopen only on a real `40P01`.
  - A job-wide advisory lock for order cleanup. It would need one transaction across all batches.
- **Still open:**
  - The 24 h staging soak at 3 replicas, which is M1's real exit criterion.
  - The ticket-service integration package starts 23 Mongo containers against one 300 s `-timeout` budget, so it can go red on a slow runner.

#### Transactional outbox hardening + CI Trivy remediation (2026-08-05 → 09-21, PR #122)

- **All four outboxes:** relay cost now tracks backlog depth, not table size.
  - ticket-service: index `idx_outbox_pending`, plus empty-poll backoff (500 ms → 5 s).
  - payment-service: `SKIP LOCKED` plus a 24 h retention purge.
  - attendance-service: retention, plus migration 008 adding `outbox.published_at`, which the code had always written.
  - order-service: a bounded claim. It stops at the first failing row so a later event for the same key cannot overtake it. `OUTBOX_RELAY_PUBLISH_TIMEOUT_MS` (10 s) bounds the broker wait.
- **attendance-service had no CI job.** Its Postgres tests had silently skipped. It now has
  one, and `requireTestPool` applies the real migrations. Tip: run golangci-lint with
  `--max-same-issues=0 --max-issues-per-linter=0` to see every finding.
- **Trivy gate root cause:**
  - `trivy-action` with `format: sarif` scans every severity, so `exit-code: 1` fired on LOW/MEDIUM findings too.
  - Fixed with a CVE sweep and Go 1.25 → 1.26. The toolchain and the `x/crypto`/`otel` bumps cannot be split, because those modules require `go 1.26`.
  - queue-service's six unfixable glibc CVEs in the chiseled .NET base get an owner-approved, job-scoped `trivyignores`. It **expires 2026-12-21**. On expiry, re-scan; delete the file if Microsoft has rebuilt the image, otherwise extend it and record why.
  - The severity gate was never narrowed.
- **Still open:** the `SSH.NET` HIGH advisories in queue-service's test project (test-only).

### 2026 Q2 (Apr–Jun)

- **Search (2026-06-24):** ticket-service OpenSearch search gained Prometheus metrics in
  `internal/metrics/`: query duration by backend, fallback count, refill iterations,
  indexer lag and reindex progress. It also gained an opt-in single-node OpenSearch Helm
  subchart (security plugin off). Dependencies: `opensearch-go/v4`, plus
  `prometheus/client_golang` promoted to direct. The posture decision is in
  `docs/06-security.md`.
- **Client GraphQL-first (2026-05-22):** every screen uses `executeQuery` /
  `executeMutation` (server) or urql (browser seat map only). `lib/api.ts` is narrowed to
  `serverApi` + `ApiError`, and the REST keep-list is in `services/client/AGENTS.md`. Hard
  stops 11–12 ban copying SDL into the client and inline gql strings. Rollback is
  `git revert --no-commit 09bea9e^..cbf61f1`, then a compose smoke test.
- **API style split (2026-05-07):** `docs/03-api-design.md` treats GraphQL as the app-facing API
  and REST + OpenAPI as the API for integrations, MCP and operational commands. The QR attendance
  plan lives in `docs/superpowers/plans/2026-05-07-qr-attendance.md`.
- **Observability (2026-04-30):**
  - Repo-managed Prometheus rules and alerts.
  - An OTel Collector metrics pipeline that makes Apollo Router metrics queryable.
  - user-service RED metrics.
  - Operator dashboards and a first-response workflow in the observability README.
  - payment-service's `OrderServiceClient` gained timeout-aware retry, jittered backoff and a circuit breaker; an unavailable lookup returns 503.
  - `CriticalServiceDown` was rehearsed live by stopping user-service; it fired, then cleared.
  - `docs/interview.md` holds the architecture knowledge graph and question bank.
- **order-service GraphQL (2026-04-23):** uses Spring GraphQL (`@Controller` +
  `@QueryMapping`), not Netflix DGS. It is Spring-native and needs no extra dependency.
  The spec and plan were updated to match.
- **Clean bootstrap (2026-04-15):** user-service and payment-service apply `migrations/*.sql`
  through one explicit runner that records checksums. `pnpm migrate` and container
  startup share it. Startup fails loudly on drift. A fresh `docker compose down -v && up`
  needs no manual SQL.
- **Linkerd for gRPC (2026-04-09):** ticket, venue and order are meshed. Port-scoped
  `Server` + `ServerAuthorization` cover the gRPC ports only, so Kong HTTP ingress is not
  blocked. `infra/local/setup.sh` installs the control plane. The ticket outbox relay is
  behind narrow interfaces with unit and Mongo integration tests.
- **Quota & seating designs approved (2026-04-01):** `docs/quota-reservation-design.md`
  and `docs/venue-seating-plan-design.md`. Decisions:
  - a separate `sold` counter (`available = quota − reserved − sold`);
  - multi-quantity from V1;
  - the Redisson lock kept as a 2 s fallback behind Lua atomicity;
  - a new `orders.order.completed` topic.
- **Lint/type hardening (PR #16, merged 2026-03-31):** auth, client and order-service
  type errors fixed. order-service has a project-tuned `checkstyle.xml`; the stock Sun and
  Google checks flagged 600–800 indentation-only issues.

### 2026 Q1 (Jan–Mar)

- **Audit remediation (PRs #8, #12):** the M8 audit's P2 set (34 items) and the resilience and
  observability set. Highlights:
  - OTel on every service, with trace ids in logs;
  - real readiness probes;
  - a circuit breaker on the order → ticket gRPC client;
  - Stripe webhook verification and idempotency keys;
  - proto prices as `string`;
  - ISO 4217 validation and unknown-field rejection;
  - Helm RollingUpdate, NetworkPolicy, HPA and topology spread.
- **Kong sandbox:** `cjson.safe` is not allow-listed. Use `cjson` with `pcall`
  (`jwt-sub.lua`).
- **Next.js Server Actions CSRF behind Kong:** Next compares `Origin` with
  `X-Forwarded-Host`, which Kong overwrites from `$upstream_x_forwarded_host`. Only
  setting `ngx.var.upstream_x_forwarded_host` in a `post-function` on the client route
  works. The client pod also needs `INTERNAL_API_URL`.
- **Local Kubernetes and Terraform:**
  - `infra/local/setup.sh` is the single-command minikube bootstrap (kubectl + helm, no Terraform locally). It fixed the ticket gRPC port 50051, annotated Linkerd skip-ports and pinned the Mongo `existingSecret`.
  - Terraform scaffolding covers the Kong module and the dev/staging/prod environments.
- **Kong JWT forwarding, startup migrations and the first Playwright E2E suite.**
