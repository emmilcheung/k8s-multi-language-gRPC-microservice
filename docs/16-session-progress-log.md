# Session Progress Log

> Append a new entry each session. Newest entry at the top.
> **Archive policy:** keep the current quarter hot. Move older quarters to `log/archive/<YYYY>-Q<N>.md` at the start of each new quarter. Last archived on **2026-04-17** (2026 Q1 → [`log/archive/2026-Q1.md`](log/archive/2026-Q1.md)).

## Archive index

- [`log/archive/2026-Q1.md`](log/archive/2026-Q1.md) — 2026 Q1 (Jan–Mar) sessions: Kong sandbox fix, CSRF fix, setup.sh hardening, Terraform scaffolding, Kong JWT forwarding + E2E suite.

---

## Session: 2026-06-24 — feat(search): metrics, opt-in OpenSearch Helm subchart, docs ✅ COMPLETE

**Branch:** `feat/opensearch-ticket-search`

### What was done

Completed Task 8 (rollout hardening) of the OpenSearch search feature in ticket-service.

#### Summary

- **New dependency:** `github.com/prometheus/client_golang v1.23.2` promoted from indirect to direct in `go.mod` (already present as a transitive dep of `echo-contrib`).
- **New search dependency (Tasks 1–7):** `github.com/opensearch-project/opensearch-go/v4 v4.6.0` — added in earlier tasks; no new deps added this session.
- **New package:** `internal/metrics/` — `SearchMetrics` struct with five Prometheus instruments registered on a caller-supplied registry (testable without the global default).
- **Metric wiring:**
  - `search_query_duration_seconds{backend}`: observed on the OpenSearch path (wraps entire refill loop) and the Mongo fallback path in `schema.resolvers.go`.
  - `search_fallback_total`: incremented in the `TicketsConnection` resolver when an OpenSearch error triggers the Mongo fallback.
  - `search_refill_iterations`: observed at the end of each resolver refill loop.
  - `search_indexer_lag_seconds`: observed in `search.Indexer.processWithRetry` after a successful decode, measuring `now - event.CreatedAt`.
  - `reindex_progress`: set as a gauge in `search.Reindex` after each page is upserted.
- **Helm subchart:** `infra/helm/charts/opensearch/` — single-node Deployment (`discovery.type=single-node`, `DISABLE_SECURITY_PLUGIN=true`, 512Mi req / 1Gi limit), ClusterIP Service on 9200. Declared in umbrella `Chart.yaml` with `condition: opensearch.enabled`. Disabled locally (`values-local.yaml`), documented in `values.yaml`.
- **Docs:** `docs/08-observability.md` (soft-dep exception + search metrics table), `README.md` (port 9200 + `docker compose --profile search`).
- **Test:** `TestSearchMetrics_Registered` in `internal/metrics/search_test.go` — no external deps, verifies all five instruments register and Counter increments correctly.

#### Commits on this branch (this session)

| Commit | Scope | Summary |
|---|---|---|
| `60962ec` | feat(search) | search metrics, opt-in opensearch helm subchart, docs |

---

## Session: 2026-05-22 — runbook(graphql): add explicit migration revert sequence ✅ COMPLETE

**Branch:** `feat/client-graphql-foundation`

### Rollback command sequence (dry-run ready)

Use a throwaway branch, then run the migration-range revert exactly in this order:

```bash
git checkout -b chore/graphql-revert-dry-run
git revert --no-commit 09bea9e^..cbf61f1
```

If the dry-run is only for rehearsing rollback mechanics, discard local changes:

```bash
git restore --staged .
git restore .
```

### Post-revert smoke check

After a real revert commit, run:

```bash
docker compose up -d --build --wait
curl -fsS http://localhost:8000/healthz/live
curl -fsS http://localhost:8001/status
```

Expected: compose healthy, gateway liveness 200, Kong status 200.

---

## Session: 2026-05-22 — feat(client): complete GraphQL Phase 4 migration ✅ COMPLETE

**Branch:** `feat/client-graphql-foundation`

### What was done

Completed the full GraphQL-first migration for the `services/client` Next.js app across Phases 4.1–4.7 plus cleanup (Stage 5).

#### Commits on this branch (newest first)

| Commit | Scope | Summary |
|---|---|---|
| Stage 5 | cleanup | Narrow `lib/api.ts`; add AGENTS.md data-fetching section; update docs |
| `4430489` | Phase 4.6 | Browser urql seat selection (HoldSeats, ReleaseSeats, 5s polling) |
| `fd2ed10` | Phase 4.7 | Attendance + scan pages → GraphQL |
| `9391482` | Phase 4.4 | Payment-method registration milestone |
| `e2baa49` | Phase 4.3 | Orders, cancel, payment → GraphQL |
| `3ebf238` | Phase 4.2 | Ticket browse + detail → GraphQL |
| `12a13ca` | Phase 4.1 | Settings page → GraphQL |
| `25c0a42` | infra | Apollo Router cookie propagation + attendance routing |

#### Key outcomes

- All app screens now use `executeQuery` / `executeMutation` from `lib/graphql/execute.ts` (server) or urql hooks (browser, seat map only).
- `lib/api.ts` narrowed to `serverApi` + `ApiError`; all domain REST wrappers removed.
- REST keep-list documented in `services/client/AGENTS.md §Data Fetching`.
- Schema gaps (SeatingPlan.name, AvailabilitySnapshot.counts) kept as REST; reasons documented.
- Hard stops 11–12 added to `docs/15-agent-hard-stops.md`: no SDL copying into client, no inline gql strings.
- `docs/03-api-design.md` updated with Phase 4 migration outcome.

### Verification (pre-commit)

| Check | Result |
|---|---|
| `pnpm tsc --noEmit` | ✅ 0 errors |
| `pnpm lint` | ✅ clean |
| `pnpm test` | ✅ 143/143 |
| Inline-gql grep | ✅ OK (0 matches) |
| REST keeplist grep | ✅ OK (0 violations) |

---

## Session: 2026-05-07 — docs(qr-attendance): register repo-grounded superpowers plan ✅ COMPLETE

**Branch:** `main`

### What was done

Registered a new superpowers-compatible implementation plan for QR-code attendance that is grounded in the current microservices repo instead of the earlier generic enterprise assumptions, then updated the API standard to reflect the repository's GraphQL-plus-REST model.

1. **`docs/superpowers/plans/2026-05-07-qr-attendance.md`** — added a continuation-friendly execution plan in the same style as the existing superpowers plans.
   The plan is explicitly scoped to the current platform and distinguishes:
   - net-new `attendance-service`
   - targeted modifications to `client`, `kong-gateway`, Helm, and only minimal existing backend surfaces
   - deferred email delivery because the repo does not currently contain a notification/email service

2. Enriched the same attendance plan with explicit implementation recommendations and a required test plan so future agent sessions do not skip the service-boundary, protocol-split, security, or regression requirements.

3. **`docs/03-api-design.md`** — updated the API standard so REST and GraphQL are both documented as first-class external API styles with different target consumers:
   - GraphQL for app-facing composed client flows
   - REST + OpenAPI for third-party integrations, MCP/agent tooling, and command-style operational endpoints

4. The plan is intentionally structured for follow-up agent sessions:
   - goal / out-of-scope / architecture / tech stack
   - explicit file map
   - checkbox workstreams
   - recommended execution order
   - release gate

5. No application code was changed in this session.

### Outcome

The repository now contains a superpowers-compatible QR attendance plan plus an updated API standard, so future agentic implementation work can follow the intended GraphQL/REST split, test strategy, and service-boundary decisions without re-deriving them from chat history.

---

## Session: 2026-04-30 — ops(observability): rehearse CriticalServiceDown alert ✅ COMPLETE

**Branch:** `feat/observability-release-gate`

### What was done

Finished the last remaining release-gate step for the pre-production observability plan.

1. Created a dedicated branch, `feat/observability-release-gate`, from the current working tree so the final validation work is isolated from `main`.
2. Performed a controlled local outage by stopping `user-service`, which is one of the critical scrape targets covered by the repo-managed `CriticalServiceDown` rule.
3. Verified Prometheus transitioned the target to `up=0` and fired `CriticalServiceDown` for `job="user-service"`.
4. Restored `user-service` with Docker Compose and verified Prometheus returned the target to `health: up` and cleared the alert.

### Verification

- `curl http://localhost:9090/api/v1/query?query=up{job="user-service"}` before outage returned `1` ✅
- `curl http://localhost:9090/api/v1/query?query=ALERTS{alertname="CriticalServiceDown"}` before outage returned no active alert ✅
- `docker compose stop user-service` triggered a real local scrape failure ✅
- Prometheus query for `ALERTS{alertname="CriticalServiceDown",alertstate="firing",job="user-service"}` returned a firing alert with `severity="critical"` ✅
- Prometheus query for `up{job="user-service"}` during outage returned `0` ✅
- `docker compose up -d user-service` restored the service ✅
- Post-recovery Prometheus queries showed `up{job="user-service"} == 1` and no remaining `CriticalServiceDown` alert for `user-service` ✅

### Outcome

The final release gate is now closed: the repository does not just define alert rules, it has a verified local rehearsal showing that a real critical scrape outage produces the expected repo-managed alert and clears again after recovery.

---

## Session: 2026-04-30 — feat(observability): wire alerts, telemetry coverage, and payment lookup resilience ✅ COMPLETE

**Branch:** `main`

### What was done

Implemented the critical pre-production observability and reliability backlog, excluding deployment/CD work.

1. **Alerting and Prometheus rule wiring**
- Added repo-managed Prometheus rule loading for the local stack and Helm chart.
- Added core platform alerts for service-down, 5xx, and latency conditions plus an async-path placeholder rule file that explicitly documents missing backlog and DLQ instrumentation.
- Updated the local observability README with the alert response loop and initial operator workflow.

2. **Apollo Router and user-service telemetry coverage**
- Added an OTel Collector metrics pipeline with a Prometheus exporter so Apollo Router OTLP metrics become queryable in Prometheus.
- Added user-service RED metrics via a Nest Prometheus module and middleware pattern aligned with the existing platform metric names.
- Updated Prometheus scrape configuration in local and Helm values to include Apollo Router and user-service.
- Repaired and extended the Grafana dashboards so platform and RED views now include Apollo Router request rate, error rate, and p95 latency panels.

3. **Payment-service synchronous dependency hardening**
- Hardened `OrderServiceClient` with timeout-aware retry, exponential backoff with jitter, an in-process circuit breaker, and Prometheus metrics for failures, retries, and breaker-open state.
- Added focused unit coverage for retry and breaker behavior and added a degraded-path integration assertion that returns 503 when order lookup is unavailable.
- Documented the new resilience configuration in the payment-service README and example env file.

4. **Operator-first dashboards and investigation workflow**
- Extended the local Grafana dashboards with payment-path panels for create success/failure rate, lookup failures, retries, and circuit-breaker state, while keeping Apollo Router panels aligned to the collector-exported metric names.
- Updated the local observability README with a fixed first-response workflow: targets first, then RED, then dependency-specific panels, then Jaeger, then logs.
- Updated the synthetic observability report to use the corrected Grafana port, verify both provisioned dashboards, sample payment and router Prometheus signals, capture refreshed screenshots, and assert async propagation from Kafka publish/process trace evidence.
- Refreshed `observability/local/docs/observability-report.json` and `observability/local/docs/observability-report.md` from a passing end-to-end run.

### Verification

- `docker compose -f observability/local/docker-compose.observability.yml config --services` ✅
- `helm template observability ./infra/helm/charts/observability` ✅
- `node -e "JSON.parse(require('fs').readFileSync('observability/local/grafana/dashboards/platform-overview.json','utf8'))"` ✅
- `node -e "JSON.parse(require('fs').readFileSync('observability/local/grafana/dashboards/services-red.json','utf8'))"` ✅
- `pnpm tsc --noEmit` in `services/user-service` ✅
- `curl -i http://localhost:3004/metrics` after rebuilding `services/user-service` ✅
- `curl http://localhost:9090/api/v1/targets` showed `apollo-router` and `user-service` scrape targets `up` ✅
- `curl -u admin:admin http://localhost:3005/api/search` confirmed Grafana dashboard provisioning on the corrected host port ✅
- `curl http://localhost:9090/api/v1/query?query=sum(rate(apollo_router_operations_total[5m]))` returned router traffic ✅
- `curl http://localhost:9090/api/v1/query?query=histogram_quantile(0.95,sum(apollo_router_query_planning_total_duration_bucket) by (le))` returned router planning latency ✅
- `pnpm test:observability-report` in `services/client` ✅
- `pnpm lint && pnpm tsc --noEmit` in `services/client` ✅
- `pnpm vitest run src/modules/payments/order-service.client.spec.ts` in `services/payment-service` ✅
- `pnpm vitest run --config vitest.integration.config.ts test/payments.integration.spec.ts --testNamePattern "order lookup is unavailable"` in `services/payment-service` ✅
- `pnpm tsc --noEmit` in `services/payment-service` ✅
- `pnpm build` in `services/payment-service` ✅

### Outcome

- The repository now has active alert evaluation, broader edge and service telemetry coverage, repaired operator dashboards, and a hardened synchronous payment lookup path.
- Follow-up fixes discovered during live validation are now included too: the local Grafana host port no longer collides with `user-service`, `user-service` exposes `/metrics` via an explicit controller, the Apollo Router dashboard queries now match the actual exported metric names, and the synthetic observability report now proves dashboard availability, payment-path metrics, router metrics, and Kafka async trace continuity from a passing golden flow.

---

## Session: 2026-04-30 — docs(interview): add backend interview knowledge graph and pressure-question bank ✅ COMPLETE

**Branch:** `main`

### What was done

Created a living interview-prep document that turns the purchase-flow architecture into a reusable knowledge graph plus question bank for senior backend interviews.

1. **`docs/interview.md`** — added a durable interview-prep document.
It includes a Mermaid knowledge graph, core invariants, senior-level pressure questions, direct repository evidence, and a discovery backlog for later expansion.

2. Expanded the same document with a dedicated payment-system deep-dive layer:
It now includes a second Mermaid graph focused on charge initiation, webhook races, outbox semantics, payment-domain gaps, and a concrete hardening path toward more payment-company-grade capabilities such as refunds, reconciliation, processed-event ledgers, and richer lifecycle modeling.

3. **`AGENTS.md`** — added the new document to the documentation index so it can be loaded on demand in future sessions.

4. No application code changes were made in this session.

### Outcome

The repository now contains a persistent interview-prep knowledge base that can be incrementally extended as new questions, failure modes, and design trade-offs are discovered.

---

## Session: 2026-04-30 — docs(reliability): add pre-production observability and resilience backlog ✅ COMPLETE

**Branch:** `main`

### What was done

Created a concrete pre-production readiness backlog focused only on the critical non-deployment gaps that should be closed before real deployment.

1. **`docs/superpowers/plans/2026-04-30-preprod-reliability-observability.md`** — added a dated implementation plan covering four workstreams:
  - active alerting and Prometheus rule groups
  - Apollo Router and user-service telemetry coverage
  - payment-service order lookup resilience hardening
  - operator-first dashboards and investigation workflow

2. Explicitly scoped out AWS environment preparation, deploy automation, and other CD concerns so the plan stays actionable even while client infrastructure is not ready.

3. No application code changes were made in this session.

### Outcome

The repository now contains a concrete backlog for the critical observability and reliability work that should be completed before the platform is treated as deployment-ready.

---

## Session: 2026-04-23 — docs(graphql-federation): document order-service Spring GraphQL deviation ✅ COMPLETE

**Branch:** `feature/graphql-federation`

### What was done

Updated spec and plan docs to reflect the actual implementation of the order-service GraphQL subgraph.

1. **`docs/superpowers/specs/2026-04-20-graphql-federation-design.md`** — replaced all Netflix DGS references in order-service context with Spring GraphQL; updated the architecture diagram label, subgraph assignments table, implementation pattern section (dependencies, file structure), DataLoader table, and rollout step 4; added a rationale note: order-service uses Spring GraphQL (`@Controller` + `@QueryMapping`/`@SchemaMapping`) instead of Netflix DGS — Spring-native, zero additional dependency, sufficient for federation via `@apollographql/federation-jvm`.

2. **`docs/superpowers/plans/2026-04-20-graphql-federation.md`** — updated Tech Stack line (Netflix DGS → Spring GraphQL), added a one-line deviation note pointing to the spec, updated File Map table (DGS-named files → actual Spring GraphQL filenames), updated Task 16 title and pom.xml dependency block, updated Task 17 title, test class, and implementation code to reflect `@Controller`-based approach.

3. No code changes were made.

### Outcome

Spec and plan now accurately reflect the implemented Spring GraphQL approach. Rationale is captured in the spec. No functional changes.

---

## Session: 2026-04-15 — Settings release hardening + clean bootstrap gate ✅ COMPLETE

**Branch:** `main`

### What was done

1. **User-service startup path hardened**
- Added a runtime SQL migration runner for `services/user-service` that applies `migrations/*.sql` in sorted order and records filename checksums in `schema_migrations`.
- Kept fail-loud startup behavior so checksum drift or SQL failures stop the container before Nest starts.
- Preserved schema-aware readiness and startup verification for `user_profiles`, `user_preferences`, and `billing_addresses`.

2. **Payment-service startup path hardened**
- Replaced the metadata-dependent runtime migrator with the same explicit SQL migration runner strategy in `services/payment-service`.
- Ensured clean boot now creates the saved-payment schema required by readiness: `payment_customers` and `saved_payment_methods`.
- Kept `/healthz/ready` as the compose health target so missing schema fails fast.

3. **Production-parity validation retained and extended**
- `pnpm migrate` in both TypeScript services now uses the same code path as container startup instead of a separate `drizzle-kit migrate` path.
- Client settings action unit coverage remained in place for session-auth routing.
- Existing settings Playwright coverage was rerun against the rebuilt stack.

4. **Clean environment proof completed**
- Rebuilt the full stack from empty volumes with `docker compose down -v && docker compose up --build --detach`.
- Verified both `payment-service` and `user-service` passed readiness from the fresh bootstrap.
- Ran the settings-focused Playwright flow successfully against the clean stack.

### Verification

- `pnpm lint && pnpm build` in `services/payment-service` ✅
- `pnpm lint && pnpm build` in `services/user-service` ✅
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:1/<db> pnpm migrate` in both services reached the new migration entrypoint and failed only on the expected connection refusal ✅
- `docker compose down -v && docker compose up --build --detach` from repo root ✅
- `curl -fsS http://localhost:3002/healthz/ready` ✅
- `curl -fsS http://localhost:3004/healthz/ready` ✅
- `pnpm exec playwright test tests/e2e/ticketing.spec.ts --grep settings` in `services/client` ✅ (3/3 passed)

### Outcome

- The settings release-hardening path now proves the audit requirement that a fresh local bootstrap does not require manual SQL.
- The clean-stack verification for saved payment methods and session/settings flows is passing end to end.

---

## Session: 2026-04-09 — Linkerd gRPC transport hardening + ticket outbox relay tests ✅ COMPLETE

**Branch:** `copilot/worktree-2026-04-08T16-22-48`

### What was done

1. **Ticket-service outbox relay test coverage added**
- Added focused package tests in `services/ticket-service/internal/outbox/relay_test.go`.
- Covered publish routing, success ack flow, failed publish requeue flow, payload mapping, and retry backoff capping.
- Refactored `internal/outbox/relay.go` to depend on narrow repo/producer interfaces so the relay is directly testable without concrete Mongo/Kafka implementations.

2. **Mongo-backed outbox integration tests added**
- Added `services/ticket-service/test/outbox_relay_integration_test.go` using the existing Testcontainers Mongo fixture.
- Covered claim leasing, ack removal, requeue state updates, expired-lease reclaim, and wrong-token rejection.

3. **Internal gRPC transport moved onto a Linkerd mesh story in Kubernetes**
- Added global Helm values for service-mesh configuration in `infra/helm/values.yaml` and `infra/helm/values-local.yaml`.
- Injected the gRPC participants into Linkerd via pod annotations in:
   - `infra/helm/charts/ticket-service/templates/deployment.yaml`
   - `infra/helm/charts/venue-service/templates/deployment.yaml`
   - `infra/helm/charts/order-service/templates/deployment.yaml`
- Added port-scoped Linkerd `Server` + `ServerAuthorization` resources for the ticket-service and venue-service gRPC ports so HTTP ingress via Kong is not blocked.

4. **Local Kubernetes bootstrap updated**
- `infra/local/setup.sh` now requires the `linkerd` CLI and installs or upgrades the Linkerd control plane before Helm deploy.
- Existing Kafka skip-port behavior remains in place for Linkerd.

### Verification

- `go test ./internal/outbox ./test -run 'Outbox|Relay|Claim|Acknowledge|Requeue'` in `services/ticket-service` ✅
- `go test ./... && go vet ./...` in `services/ticket-service` ✅
- `helm dependency build ./infra/helm` ✅
- `helm template ticketing ./infra/helm -f ./infra/helm/values-local.yaml` ✅

### Follow-up

- A full local Kubernetes run of `./infra/local/setup.sh` was not executed in this session, so live cluster verification of Linkerd-enforced traffic remains the next operational check.

---

## Session: 2026-04-01 — Quota & Seating Plan Design: Open Questions Resolved ✅ READY FOR IMPLEMENTATION

**Branch:** N/A (design documents only)

### What was done

1. **Comprehensive codebase exploration** of all 5 existing services — architecture, models, handlers, Kafka events, gRPC, database schemas.

2. **GA Quota Design Document** written at `docs/quota-reservation-design.md`:
   - 9 sections covering model changes, Redis Lua scripts, phased implementation (11 phases), breaking changes, migration strategy, 30+ unit tests, 5 load test scenarios, risk analysis.

3. **Venue Seating Plan Design Document** written at `docs/venue-seating-plan-design.md`:
   - 20 sections covering new venue-service architecture, seat state machine, hold mechanism (Redis Lua scripts), reservation flows (4 flows), auto-assign algorithm, SSE real-time, cross-service integration, order model changes, PostgreSQL schema, gRPC proto definitions, template system, 14 implementation phases.

4. **All critical open questions resolved** via stakeholder Q&A:

| Decision | Resolution |
|---|---|
| Sold counter | Option A: Separate `sold` field. `available = quota - reserved - sold`. |
| Multi-quantity V1 | Yes — support from V1. `CreateOrderRequest.quantity` defaults to 1. |
| Redisson lock | Keep as fallback safety net with reduced TTL (2s). Primary atomicity from Lua scripts. |
| `orders.order.completed` topic | Add new Kafka topic. Producer: order-service. Consumers: venue-service + ticket-service. |

5. **Both design documents updated** with all resolved decisions:
   - Status changed from DRAFT to APPROVED
   - Open questions section updated with resolutions
   - Ticket model includes `sold` field throughout
   - Reservation flow updated with Redisson fallback
   - New `MarkSold` method added to QuotaManager, TicketRepository interfaces
   - `orders.order.completed` event schema documented
   - Kafka consumer updated with `handleOrderCompleted` handler

### Next steps

1. **Begin implementation** starting with proto changes (Phase 1 in quota doc / Phase 0 in seating doc)
2. Implementation order: proto → ticket-service quota → order-service changes → venue-service scaffold
3. Non-blocking design questions (seat labels, rendering tech, template sharing) deferred to relevant implementation phases

---

## Session: 2026-04-01 — Post-audit lint/type hardening: PR #16 ⏳ AWAITING REVIEW

**Branch:** `fix/audit-typescript-errors` → PR #16 (open, awaiting owner review).

### What was done

Completed a full lint and type-check pass across all six services, discovering and fixing post-audit regressions not captured by the AUDIT-TODO checklist.

**1. auth-service — TypeScript errors in integration test (9 → 0)**
- File: `test/auth.integration.spec.ts`
- Root cause A: Audit fix O-04 refactored `GlobalExceptionFilter` to require DI-injected `Logger`; the integration test still called `new GlobalExceptionFilter()` with no argument → TS2554.
  Fix: added `import { Logger } from 'nestjs-pino'`; changed instantiation to `new GlobalExceptionFilter(moduleRef.get(Logger))`.
- Root cause B: supertest v7.2.2 + `@types/supertest ^6.0.3` type mismatch — v7 types the `set-cookie` response header as `string`, but the test code cast to `string[]` → 8× TS2352.
  Fix: inserted `unknown` intermediary: `as unknown as string[] | undefined`.

**2. client — TypeScript errors in unit test (2 → 0)**
- File: `__tests__/pages.test.tsx`
- Root cause: `vi.fn<() => Promise<TicketPage>>()` is typed as a no-argument function; spreading `unknown[]` into it fails TS2556.
  Fix: `mockFn(...args as Parameters<typeof mockFn>)` at both call sites.

**3. order-service — Checkstyle configuration and import hygiene**
- AGENTS.md mandates `mvn -q checkstyle:check` but no plugin existed; the
  default Sun checks produced 676 violations and Google checks produced 817 (all on
  4-space indentation the project doesn't use).
- Created `services/order-service/checkstyle.xml` — project-tuned rules:
  `AvoidStarImport`, `UnusedImports`, `RedundantImport`, `IllegalImport`,
  naming conventions (TypeName, MemberName, ParameterName, LocalVariableName,
  MethodName, PackageName), `ConstantName` with SLF4J `log`/`logger` exception,
  `EmptyCatchBlock`, `FallThrough`, `MultipleVariableDeclarations`, `UpperEll`,
  `ArrayTypeStyle`, `ModifierOrder`.
- Updated `pom.xml` to reference `checkstyle.xml` instead of `google_checks.xml`.
- Fixed 4 star-import violations:
  - `Order.java`: `jakarta.persistence.*` → 12 explicit imports
  - `OutboxMessage.java`: `jakarta.persistence.*` → 7 explicit imports
  - `OrderTicket.java`: `jakarta.persistence.*` → 7 explicit imports
  - `OrderController.java`: `org.springframework.web.bind.annotation.*` → 8 explicit imports
- Removed stale unused `KafkaTemplate` import from `OutboxRelay.java`.

### Verification Matrix

| Service | Command | Result |
|---|---|---|
| auth-service | `pnpm tsc --noEmit` | ✅ 0 errors |
| client | `pnpm tsc --noEmit` | ✅ 0 errors |
| payment-service | `pnpm tsc --noEmit` | ✅ 0 errors |
| ticket-service | `go vet ./...` | ✅ clean |
| expiration-service | `go vet ./...` | ✅ clean |
| order-service | `mvn -q checkstyle:check` | ✅ 0 violations |

### PR Summary

**PR #16**: fix: post-audit lint and type hardening
- **Branch**: `fix/audit-typescript-errors`
- **Status**: ⏳ AWAITING OWNER REVIEW
- **Commits**: 1
- **Files Changed**: 9 (+115 / -17 lines)
- **Breaking Changes**: None
