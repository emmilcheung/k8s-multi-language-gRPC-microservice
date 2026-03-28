# Platform Build Status Log

> **Last Updated:** 2026-03-28 UTC  
> **Current Phase:** Audit Remediation in Progress (M6 complete; M1–M5, M7–M10 pending)  
> **Overall Progress:** ~75% of full plan (all services built and E2E tested; audit remediation underway; EKS not yet applied)  
> **Git Status:** `main` is clean at `850b975` (fix/audit-m6-resilience-obs merged).

---

## Executive Summary

| Concern | Status | Details |
|---|---|---|
| **Project Setup** | ✅ Complete | PLAN.md, AGENTS.md, docker-compose, workflow tools |
| **auth-service** | ✅ Complete | TypeScript/NestJS, Drizzle ORM, RS256 JWT, 28 tests passing |
| **ticket-service** | ✅ Complete | Go/Echo, MongoDB, gRPC server (port 50051), Kafka producer + consumer, 29 tests passing |
| **order-service** | ✅ Complete | Java 21/Spring Boot 4, JPA, Flyway, Kafka, gRPC client |
| **payment-service** | ✅ Complete | TypeScript/NestJS, Drizzle ORM, Kafka consumer/producer, 25 tests passing |
| **expiration-service** | ✅ Complete | Go, asynq, Redis, Kafka |
| **client** | ✅ Complete | Next.js 15 App Router, shadcn/ui, all pages, Server Actions |
| **Kong API Gateway** | ✅ Complete | DB-less declarative config; JWT plugin (RS256); post-function sub→X-User-Id forwarding; startup migrations |
| **E2E Playwright tests** | ✅ 18/18 passing | Auth, ticket CRUD, order lifecycle, payment via Kafka — against both Docker Compose and minikube |
| **Docker Compose** | ✅ Running | `docker compose up --build` starts all services + infra |
| **Local Kubernetes (minikube)** | ✅ Complete | `infra/local/setup.sh` — idempotent 7-step bootstrap; 18/18 E2E pass against minikube cluster |
| **Helm umbrella chart** | ✅ Complete | `infra/helm/` with `values-local.yaml`; cp-kafka sub-chart (Confluent); Linkerd mTLS integration |
| **Terraform modules** | ✅ Scaffolded | vpc, eks, rds, elasticache, msk, kong modules + dev/staging/prod environments written; **not applied against real AWS** |
| **CI/CD** | ✅ Partial | `.github/workflows/` — ci.yml, e2e.yml present and green (unit + integration + Trivy + Playwright); deploy stages not yet added |
| **EKS deploy** | ⏭️ Pending | Terraform apply against real AWS deferred; local minikube is the active dev environment |
| **Observability stack** | ✅ OTel complete | OTel SDK on all 6 services; traceId/spanId in all logs (M6). AMP/AMG/X-Ray collector wiring deferred. |
| **Audit remediation** | 🟡 In progress | M6 merged (`850b975`). M1–M5, M7–M10 pending. See [AUDIT-SCHEDULE.md](./audit/AUDIT-SCHEDULE.md). |

---

## Completed Milestones

### Milestone 1: Project Setup & Infrastructure

**Branch:** `setup/project-infrastructure` (merged to main)

**Deliverables:**
- ✅ PLAN.md — architecture, tech choices, service specs, deployment strategy
- ✅ AGENTS.md — engineering standards (§0–15) + implementation conventions (§16)
- ✅ docker-compose.yml — all infra containers (PostgreSQL ×3, MongoDB, Redis, Kafka KRaft, Schema Registry) + all service containers
- ✅ STATUS.md — project status tracking
- ✅ workflow.sh + WORKFLOW.md — CLI workflow tools
- ✅ .gitignore — excludes /legacy, .env, build artifacts

**Key Decisions:**
- Monorepo: `/services/<service-name>`, `/infra`, `/proto`
- Stack: TypeScript (Node.js 24 LTS, pnpm, Vitest), Go 1.23+, Java 21, Next.js 15
- Testing: real databases via Testcontainers, no mocks
- Messaging: Kafka KRaft for dev (no ZooKeeper)
- ORM: Drizzle (Node.js), Spring Data JPA (Java)

---

### Milestone 2: auth-service

**Branch:** `feat/auth-service` (merged to main)

**Stack:** TypeScript, Node.js 24 LTS, NestJS 10, Drizzle ORM, PostgreSQL 16, pnpm, Vitest

- ✅ NestJS modules: auth, health, metrics, users
- ✅ Config validation (Joi), fail-loud startup
- ✅ Drizzle ORM schema + migrations; users table with UUID PK
- ✅ Signup, signin, signout endpoints
- ✅ RS256 JWT signing; JWKS endpoint at `/.well-known/jwks.json`
- ✅ argon2id password hashing
- ✅ `/healthz/live`, `/healthz/ready`, `/metrics`
- ✅ nestjs-pino structured JSON logging
- ✅ Multi-stage Dockerfile, non-root user
- ✅ 28 tests (14 unit + 14 integration via Testcontainers PostgreSQL)
- ✅ Startup migration: `src/migrate.ts` runs drizzle-orm migrator before `main` (fixes fresh-cluster schema issue)

---

### Milestone 3: ticket-service

**Branch:** `feat/ticket-service` (merged to main)

**Stack:** Go 1.23+, Echo v4, MongoDB 7, segmentio/kafka-go, testify, testcontainers-go

- ✅ `/cmd/server`, `/internal/{config,handler,service,repository,kafka,middleware}`, `/pkg/logger`
- ✅ zap structured JSON logger
- ✅ MongoDB: connection pooling, JSON schema validator, indexes, OCC via `version` field
- ✅ Kafka producer: `tickets.ticket.created`, `tickets.ticket.updated` (CloudEvents v1.0, `acks=all`)
- ✅ Kafka consumer: `orders.order.created`, `orders.order.cancelled` → `ReserveTicket`/`ReleaseTicket`
- ✅ gRPC server on port **50051**: `GetTicket`, `ValidateTicketAvailability`
- ✅ HTTP REST API on port 8080: CRUD for tickets
- ✅ `/healthz/live`, `/healthz/ready`, `/metrics`
- ✅ Multi-stage Dockerfile, non-root user
- ✅ 29 tests (16 unit + 13 integration via Testcontainers MongoDB)

> **Note:** gRPC port is **50051** (not 9090 as written in earlier PLAN.md spec).

---

### Milestone 4: order-service

**Branch:** `feat/order-service` (merged to main)

**Stack:** Java 21, Spring Boot 4, Spring Data JPA, Flyway, Spring Kafka, gRPC client

- ✅ Order CRUD: create, list, get, cancel
- ✅ gRPC client → ticket-service `ValidateTicketAvailability` (deadline 5 s)
- ✅ Flyway migrations: `orders`, `order_tickets`, `outbox` tables
- ✅ Transactional outbox pattern for Kafka publishing
- ✅ Kafka: produces `orders.order.created`, `orders.order.cancelled`; consumes `tickets.ticket.created`, `tickets.ticket.updated`, `payments.payment.captured`, `expiration.order.expiration_complete`
- ✅ Multi-stage Dockerfile (Maven → eclipse-temurin:21-jre-alpine); build context is repo root (copies `/proto`)
- ✅ Spring Boot Actuator: `/actuator/health/liveness`, `/actuator/health/readiness`, `/actuator/prometheus`

---

### Milestone 5a: payment-service

**Branch:** `feat/payment-service` (merged to main)

**Stack:** TypeScript, Node.js 24 LTS, NestJS 10, Drizzle ORM, PostgreSQL 16, pnpm, Vitest

- ✅ NestJS modules: payments, health, metrics
- ✅ `POST /api/payments` — idempotent payment creation; mock guard (`STRIPE_SECRET_KEY=test_mock`)
- ✅ Produces `payments.payment.captured` (CloudEvents v1.0) to Kafka
- ✅ Consumes `orders.order.created`, `orders.order.cancelled` — maintains local `payment_orders` replica
- ✅ Startup migration: `src/migrate.ts` (same pattern as auth-service)
- ✅ 25 tests (14 unit + 11 integration via Testcontainers PostgreSQL)

---

### Milestone 5b: expiration-service

**Branch:** `feat/expiration-service` (merged to main)

**Stack:** Go 1.23+, Echo v4 (health/metrics only), asynq, Redis, segmentio/kafka-go

- ✅ Consumes `orders.order.created` → schedules asynq delayed job at `expiresAt`
- ✅ When job fires → publishes `expiration.order.expiration_complete`
- ✅ `/healthz/live`, `/healthz/ready`, `/metrics`
- ✅ Multi-stage Dockerfile, non-root user

---

### Milestone 6: client (Next.js 15)

**Branch:** `feat/client` (merged to main)

**Stack:** TypeScript, Next.js 15 App Router, shadcn/ui, Tailwind CSS, pnpm

- ✅ Pages: `/` (ticket list), `/auth/signup`, `/auth/signin`, `/tickets/new`, `/tickets/[ticketId]`, `/orders`, `/orders/[orderId]`
- ✅ httpOnly cookie auth; reads `X-User-Id` from Kong-forwarded header
- ✅ Multi-stage Dockerfile (`next build --standalone`)
- ✅ Playwright E2E test suite: 18 tests covering auth, tickets, orders, payment

---

### Kong API Gateway Integration

**Branch:** `feature/e2e-api-gateway` → `feat/kong-jwt-sub-forwarding` (merged to main at `f43e2a6`)

- ✅ DB-less declarative config (`infra/kong/kong.yml`)
- ✅ JWT plugin: RS256, JWKS from auth-service `/.well-known/jwks.json`, cookie token extraction
- ✅ Post-function plugin: extracts `sub` from validated JWT → injects `X-User-Id` header upstream
- ✅ `request-transformer` plugin: strips spoofed `X-User-Id` from incoming client requests
- ✅ Routes: `/api/users/*`, `/.well-known/jwks.json`, `/api/tickets/*`, `/api/orders/*`, `/api/payments/*`, `/*` (Next.js catch-all)
- ✅ Real RS256 key pair in `docker-compose.yml` (dev-only; known security trade-off accepted)

---

### Local Kubernetes Environment (minikube)

**Branch:** `ops/local-deployment` (merged to main at `3135626`)

- ✅ `infra/local/setup.sh` — idempotent 7-step bootstrap (tools check → minikube → build+load images → namespace → Linkerd annotation → secrets → helm install → tunnel)
- ✅ `infra/helm/` — umbrella Helm chart with Bitnami sub-charts (PostgreSQL ×3, MongoDB, Redis) + custom `cp-kafka` sub-chart
- ✅ `infra/helm/charts/cp-kafka/` — Confluent cp-kafka:7.7.1; INTERNAL listener (9092 in-cluster) + EXTERNAL LoadBalancer (9093 via `minikube tunnel`) for E2E test producer
- ✅ `infra/helm/values-local.yaml` — minikube overrides: 1 replica, small resources, inline passwords, `kafka.enabled: false` (Bitnami), `cp-kafka.enabled: true`
- ✅ `infra/local/secrets.env.example` — template; user fills in `RSA_PRIVATE_KEY` + `STRIPE_SECRET_KEY`
- ✅ Linkerd mTLS: `config.linkerd.io/skip-outbound-ports: "9092"` on `ticketing` namespace (prevents Linkerd intercepting Kafka binary protocol); `skip-inbound-ports/skip-outbound-ports: "9093"` on cp-kafka pod template
- ✅ Terraform modules scaffolded: vpc, eks, rds, elasticache, msk, kong — dev/staging/prod environments written (**not applied against real AWS**)
- ✅ 18/18 Playwright E2E tests passing against minikube cluster

---

### Audit Remediation — M6: Resilience & Observability

**Branch:** `fix/audit-m6-resilience-obs` → squash-merged into `main` (`850b975`) — 2026-03-28

**Findings addressed (12 of 12):**

| ID | Finding | Status |
|---|---|---|
| R-01 | Circuit breaker on order-service gRPC client (resilience4j) | ✅ |
| R-05 | Kafka publish made fire-and-forget; failure no longer silently discarded | ✅ |
| R-07 | expiration-service readiness probe: real Redis + Kafka checkers, returns 503 | ✅ |
| R-08 | gRPC server interceptors in ticket-service (logging + panic recovery) | ✅ |
| R-09 | Kong `request-size-limiting` plugin (1 MB global cap) | ✅ |
| R-11 | Stripe webhook handler in payment-service | ✅ |
| R-12 | Stripe idempotency key on PaymentIntent create | ✅ |
| R-15 | KafkaAdmin reads `bootstrap-servers` from `@Value` (not hardcoded) | ✅ |
| I-19 | Duplicate rate-limiting plugin removed; consumer-scoped limit only | ✅ |
| O-01 | OTel SDK on all 6 services (NestJS auto-instrumentation, otelecho, OTel Java agent) | ✅ |
| O-02 | `traceId`/`spanId` injected into all structured log output | ✅ |
| O-04 | `GlobalExceptionFilter` registered via DI with injected `PinoLogger` | ✅ |

**Hotfix also included:** Kong `jwt-sub.lua` — `require "cjson.safe"` replaced with Lua pattern matching (Kong 3.7 sandbox blocks all `require()` calls, including `cjson`). This also closes S-19 from M5.

**E2E:** 18/18 passing. CI: green (run `23669507272`).

---

## Pending Milestones

### Audit Remediation — M1–M5, M7–M10 (pending)

See [AUDIT-SCHEDULE.md](./audit/AUDIT-SCHEDULE.md) and [AUDIT-TODO.md](./audit/AUDIT-TODO.md) for full checklists.

| Milestone | Priority | Key work |
|---|---|---|
| M1 — Data Integrity | P0 | `@Transactional` bypass fix, payment Kafka producer, stuck-payment fix |
| M2 — Security Critical | P0 | Strip `X-User-Id` globally, payment auth, secrets out of docker-compose, root user fix, digest pinning |
| M3 — DLQ / Resilience | P0 | DLQ in ticket-service + expiration-service consumers |
| M4 — CI Deploy | P0 | Deploy stages, smoke tests, rollback, remove `:latest` |
| M5 — Auth Hardening | P1 | Refresh token rotation, cookie `maxAge`, proper cookie parser *(S-19 already done)* |
| M7 — Performance + Helm | P1 | Pagination, caching, Helm tag discipline, OutboxRelay fix, OCC, gRPC channel shutdown |
| M8 — Security + Correctness | P2 | JWT blacklist, unknown-property rejection, currency validation, dead code removal |
| M9 — Quality + Testing | P2 | RED metrics, NetworkPolicy, topology constraints, improved test coverage |
| M10 — Tech Debt | P3 | Dependency cleanup, config/naming fixes, dead code |

### Milestone 8: CI/CD Pipelines (deploy stages)

- [ ] `.github/workflows/ci-auth.yaml`, `ci-ticket.yaml`, `ci-order.yaml`, `ci-payment.yaml`, `ci-expiration.yaml`, `ci-client.yaml`
- [ ] `ci-proto.yaml` (buf lint + breaking check + stub regeneration)
- [ ] `ci-terraform.yaml` (fmt + validate + plan on PR, apply on merge)
- [ ] GitHub OIDC → IAM role assumption (no long-lived AWS keys)
- [ ] Image tag = Git SHA; push to ECR

### Milestone 9: EKS Deploy + Staging

- [ ] `infra/scripts/bootstrap-state.sh` — S3 + DynamoDB state backend
- [ ] `terraform apply` for dev environment (VPC, EKS, RDS ×3, ElastiCache, Strimzi Kafka, Kong, Schema Registry)
- [ ] All services deployed to EKS dev via Helm
- [ ] E2E tests run against EKS dev (same Playwright suite)
- [ ] Staging environment provisioned + smoke tested
- [ ] Runbook: prod deploy gate, rollback procedure, secret rotation

---

## Known Issues / Technical Debt

| Item | Severity | Notes |
|---|---|---|
| RSA private key in `docker-compose.yml` | Medium | Dev-only; real key committed for convenience. Tracked as S-15+S-16 (M2). |
| No deploy stages in CI | High | Pipelines build/test/push but do not deploy. Tracked as I-11 (M4). |
| DLQ not implemented in consumers | High | ticket-service and expiration-service consumers have no retry/DLQ. Tracked as R-03/R-04 (M3). |
| `@Transactional` self-invocation bypass | Critical | order-service outbox not truly transactional. Tracked as C-01 (M1). |
| Bitnami kafka disabled locally | Low | `bitnami/kafka` has no Docker Hub tags. Replaced by custom `cp-kafka` sub-chart using `confluentinc/cp-kafka:7.7.1`. |

---

## Docker Compose Infrastructure (local dev without K8s)

```bash
docker compose up --build
```

| Container | Port | Purpose |
|---|---|---|
| postgres-auth | 5432 | auth-service database |
| postgres-orders | 5433 | order-service database |
| postgres-payments | 5434 | payment-service database |
| mongodb | 27017 | ticket-service database |
| redis | 6379 | expiration-service job queue |
| kafka | 9092 (internal) / 9093 (host) | Event streaming |
| schema-registry | 8081 | Confluent Schema Registry |
| auth-service | 3000 | — |
| ticket-service | 3001 | — |
| payment-service | 3002 | — |
| order-service | 8082 | — |
| kong (proxy) | 8000 | API Gateway |

---

## Git Workflow

- **Strategy:** Trunk-based development; short-lived feature branches off `main`, squash-merged
- **Branch naming:** `feat/<service>`, `fix/<desc>`, `chore/<desc>`, `ops/<desc>`
- **Commit format:** Conventional Commits (`feat`, `fix`, `chore`, `ci`, `docs`, `test`, `perf`, `refactor`)
- **Merge rule (AGENTS.md §16.10):** Never auto-merge. Owner must explicitly approve before anything touches `main`.
- **Current `main`:** `850b975` — clean working tree (fix/audit-m6-resilience-obs merged)

---

## Project Checkpoint

**Blockers:** None  
**Risk:** Low — all services built and E2E verified  
**Next action:** Start M1 (`fix/audit-m1-data-integrity`) — P0 data integrity fixes are the highest priority remaining work before any staging deployment.
