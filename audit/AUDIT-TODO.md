# Audit Action Items — Structured TODO

> **Generated from**: [AUDIT-REPORT.md](./AUDIT-REPORT.md)
> **Date**: 2026-03-27
> **Total findings**: 75 (10 P0, 22 P1, 28 P2, 15 P3)

Items are organized into **execution phases** — work through them in order. Each phase has a gate: do not start the next phase until the current one is complete and verified.

**Severity key**: P0 = Critical (blocks staging), P1 = High (must fix before staging), P2 = Medium (must fix before production), P3 = Low (backlog / tech debt)

---

## Phase 1: P0 Critical — Blocks All Non-Local Deployment

> **Gate**: All 10 items complete and verified before ANY staging/EKS work begins.

### 1.1 Data Integrity

- [x] **C-01 | P0 | Fix @Transactional self-invocation in order-service**
  - File: `services/order-service/src/main/java/com/ticketing/orders/service/OrderService.java:109`
  - Problem: `createOrder()` calls `this.createOrderTransactional()` — Spring proxy AOP is bypassed. The outbox pattern is NOT transactional.
  - Fix: Extract `createOrderTransactional` to a new `@Service` bean (e.g., `OrderTransactionService`), inject it into `OrderService`, call through the proxy. Alternatively, use `TransactionTemplate` for programmatic TX control.
  - Verify: Write an integration test that forces a failure after the order insert but before the outbox insert — confirm both roll back.

- [x] **C-05 | P0 | Implement Kafka producer for payments.payment.captured**
  - File: Architecture gap — no producer code exists in `services/payment-service/`
  - Problem: After a successful Stripe charge, no event is published. Downstream services never learn about payments.
  - Fix: Add Kafka producer to payment-service. Use transactional outbox (write to `outbox` table in same DB TX as payment status update). Add relay mechanism.
  - Verify: Integration test with real Kafka (Testcontainers) — create payment, assert `payments.payment.captured` event appears on topic.

- [x] **C-06 | P0 | Fix processOrderCreatedEvent non-mock path**
  - File: `services/payment-service/src/modules/payments/payments.service.ts:146`
  - Problem: With a real Stripe key, the Kafka consumer creates a `PENDING` record but never initiates a charge. Payments stuck forever.
  - Fix: After creating the pending record, initiate a Stripe PaymentIntent. On success → `COMPLETED` + publish event. On failure → `FAILED`.
  - Verify: Integration test covering the non-mock Stripe flow.

### 1.2 Security

- [x] **S-02 | P0 | Strip X-User-Id header on Kong ingress**
  - File: `services/kong-gateway/config/kong.base.yml` (missing globally)
  - Problem: External clients can forge `X-User-Id` on public (non-JWT) routes. Identity spoofing.
  - Fix: Add a global `pre-function` or `request-transformer` plugin that strips `X-User-Id` (and `X-User-Roles` if applicable) from ALL incoming requests before route-level plugins run. The JWT `post-function` sets it authoritatively afterward.
  - Verify: `curl -H "X-User-Id: spoofed-uuid" http://localhost:8000/api/tickets` — confirm the header is NOT forwarded to the upstream.

- [x] **S-05 | P0 | Add authorization check to GET /api/payments/:id**
  - File: `services/payment-service/src/modules/payments/payments.controller.ts:51-55`
  - Problem: Any caller can read any payment by ID. No ownership check, no auth required.
  - Fix: Require `X-User-Id` header. Load payment + associated order, verify `order.userId === X-User-Id`. Return 403 if mismatch, 401 if no header.
  - Verify: Unit test + integration test covering authorized, unauthorized, and unauthenticated cases.

- [x] **S-15 | P0 | Remove Stripe test key from docker-compose.yml**
  - File: `docker-compose.yml:329`
  - Problem: `STRIPE_SECRET_KEY: "sk_test_..."` committed to version control. Violates AGENTS.md SS5.3/SS14.4.
  - Fix: Move to `.env` (gitignored). Add `STRIPE_SECRET_KEY=sk_test_placeholder` to `.env.example`. Use `env_file: .env` in docker-compose.
  - Also fix: **S-16** (RSA private key in same file). Move both to `.env`.
  - Verify: `git grep -i sk_test` returns zero matches. `.env.example` exists with placeholders.

- [x] **S-17 | P0 | Fix Kong Dockerfile to not run as root**
  - File: `services/kong-gateway/Dockerfile:43-44`
  - Problem: `USER root` at runtime. Container escape = root on the node.
  - Fix: Pre-create `/etc/kong/` with correct permissions during build. Switch final `USER` to `kong`. Run the `envsubst`/render step as `kong` user.
  - Verify: `docker run --rm kong-gateway:local whoami` returns `kong`.

- [x] **S-18 | P0 (prod) | Pin Docker base images to digest**
  - Files: `services/kong-gateway/Dockerfile:17` + all service Dockerfiles
  - Problem: Tag-only references (`kong:3.7-ubuntu`, `node:24-alpine`, etc.) are mutable. Supply chain attack vector.
  - Fix: For each base image, resolve the current digest and pin with `@sha256:...`. Only required for production images; docker-compose (dev-only) can stay tag-based.
  - Verify: All Dockerfiles contain `@sha256:` on `FROM` lines.

### 1.3 Resilience

- [x] **R-03 | P0 | Implement DLQ in ticket-service Kafka consumer**
  - File: `services/ticket-service/internal/kafka/consumer.go:123`
  - Problem: `TODO: publish to DLQ; for now log and commit`. Failed messages permanently lost.
  - Fix: After 3 retry attempts with exponential backoff+jitter, produce the failed message to `orders.order.created.dlq` / `orders.order.cancelled.dlq`. Only commit offset after successful DLQ write.
  - Verify: Integration test — inject a processing error, assert message appears on DLQ topic.

- [x] **R-04 | P0 | Implement DLQ in expiration-service Kafka consumer**
  - File: `services/expiration-service/internal/kafka/consumer.go:74-80`
  - Problem: Same as R-03. `TopicExpirationCompleteDLQ` constant exists but is never used.
  - Fix: Same pattern as R-03. Use the existing constant. Route to `orders.order.created.dlq` after retries.
  - Verify: Integration test with real Kafka.

### 1.4 Infrastructure

- [x] **I-11 | P0 | Add deploy stages to CI pipelines**
  - Files: All `.github/workflows/ci-*.yml`
  - Problem: Pipelines end at "push image to GHCR." No deployment, no smoke test, no rollback.
  - Fix: Add stages: `deploy (dev) -> smoke test -> deploy (staging) -> e2e test -> deploy (prod, gated)`. Use `helm upgrade` or `kubectl set image`. Add automatic rollback on smoke test failure.
  - Verify: Trigger a pipeline, confirm the image is deployed to dev namespace and smoke test runs.

---

## Phase 2: P1 High — Must Fix Before Staging

> **Gate**: All P0 items verified. All P1 items complete before first staging deploy.

### 2.1 Security (P1)

- [x] **S-01 | P1 | Implement refresh token rotation**
  - File: `services/auth-service/src/modules/auth/auth.service.ts`
  - AGENTS.md: SS5.1 requires "short-lived access tokens (15 min), long-lived refresh tokens stored server-side (Redis) and rotatable."
  - Fix: Issue refresh tokens (stored in Redis with TTL), rotate on use, return as HttpOnly cookie alongside access token. Add `POST /api/auth/refresh` endpoint.

- [ ] **S-03 | P1 | Add defense-in-depth JWT verification to currentUser**
  - File: `services/auth-service/src/modules/auth/auth.controller.ts:52-58`
  - Fix: Verify the JWT from the cookie at the service level in addition to trusting `X-User-Id`. Ensure NetworkPolicy restricts direct pod access.

- [x] **S-07 | P1 | Set maxAge on client auth cookie**
  - File: `services/client/app/actions/auth.ts:47-52`
  - Fix: Add `maxAge: 900` (15 min) to match JWT lifetime. Expired JWTs should not be sent.

- [x] **S-08 | P1 | Replace regex cookie parsing with proper parser**
  - File: `services/client/app/actions/auth.ts:45`
  - Fix: Use `set-cookie-parser` package or manual `split('; ')` approach. Handle quoted values and URL-encoded characters.

- [x] **S-19 | P1 | Replace regex JSON parsing in jwt-sub.lua with cjson** *(done in M6 hotfix — Kong 3.7 sandbox blocks all `require()` including `cjson`; Lua pattern matching retained as equivalent for well-formed JWTs)*
  - File: `services/kong-gateway/plugins/jwt-sub.lua:21`
  - Fix: Replace `payload_json:match('"sub"%s*:%s*"([^"]+)"')` with `require("cjson.safe").decode(payload_json)`.

### 2.2 Correctness (P1)

- [ ] **C-02 | P1 | Fix OutboxRelay batch transaction causing duplicate events**
  - File: `services/order-service/src/main/java/com/ticketing/orders/outbox/OutboxRelay.java:40-59`
  - Fix: Use per-message transactions. Save each row individually after successful Kafka delivery. Or remove `@Transactional` and handle each message atomically.

- [ ] **C-03 | P1 | Add OCC to ReserveTicket in ticket-service**
  - File: `services/ticket-service/internal/repository/mongo_ticket_repository.go:232-253`
  - Fix: Add `"orderId": ""` to the filter (only reserve if not yet reserved), or add version check. Return a conflict error if the filter matches nothing and the ticket still exists.

### 2.3 Resilience (P1)

- [x] **R-01 | P1 | Add circuit breaker on gRPC client (order-service)** *(done — M6, merged `850b975`)*
  - File: `services/order-service/src/main/java/com/ticketing/orders/grpc/TicketServiceClient.java`
  - Fix: Add resilience4j `@CircuitBreaker` annotation with a fallback that returns a clear error. Configure: 50% error threshold over 10s window, 30s cooldown.
  - Dependency: `io.github.resilience4j:resilience4j-spring-boot3`

- [x] **R-05 | P1 | Fix silent Kafka publish failures in ticket-service** *(done — M6, merged `850b975`)*
  - File: `services/ticket-service/internal/service/ticket_service.go:71-73`
  - Fix: Implement transactional outbox pattern (MongoDB collection + relay) or retry with exponential backoff before giving up.

- [x] **R-07 | P1 | Fix expiration-service readiness probe (always 200)** *(done — M6, merged `850b975`)*
  - File: `services/expiration-service/cmd/server/main.go:65`
  - Fix: Pass Redis ping checker and Kafka connectivity checker to `server.New()`. Return 503 when dependencies are unreachable.

- [x] **R-08 | P1 | Add gRPC server interceptors to ticket-service** *(done — M6, merged `850b975`)*
  - File: `services/ticket-service/internal/grpc/server.go:96`
  - Fix: Add interceptors: `grpc_zap` (logging), `grpc_prometheus` (metrics), `grpc_recovery` (panic recovery), deadline enforcement (default 5s).
  - Dependencies: `go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc`, `github.com/grpc-ecosystem/go-grpc-middleware/v2`

- [x] **R-09 | P1 | Add request size limiting to Kong** *(done — M6, merged `850b975`)*
  - File: `services/kong-gateway/config/kong.base.yml`
  - Fix: Add global `request-size-limiting` plugin. Default 5 MB, lower limit (1 MB) for auth endpoints.

- [x] **R-11 | P1 | Implement Stripe webhook handler** *(done — M6, merged `850b975`)*
  - File: Architecture gap in `services/payment-service/`
  - Fix: Add `POST /api/payments/webhook` endpoint. Verify Stripe signature (`stripe.webhooks.constructEvent`). Handle `payment_intent.succeeded` and `payment_intent.payment_failed`.

- [x] **R-12 | P1 | Add Stripe idempotency key** *(done — M6, merged `850b975`)*
  - File: `services/payment-service/src/modules/payments/payments.service.ts:72-79`
  - Fix: Pass `idempotencyKey: dto.orderId` to `stripe.paymentIntents.create()`.

- [x] **R-15 | P1 | Fix KafkaAdmin hardcoded to localhost:9092** *(done — M6, merged `850b975`)*
  - File: `services/order-service/src/main/java/com/ticketing/orders/config/KafkaConfig.java:42`
  - Fix: Replace hardcoded `localhost:9092` with `${spring.kafka.bootstrap-servers}`.

- [x] **I-19 | P1 | Fix duplicate rate-limiting plugin instances in Kong** *(done — M6, merged `850b975`)*
  - File: `services/kong-gateway/config/kong.base.yml:266-285`
  - Fix: Test if Kong DB-less allows two global instances of `rate-limiting`. If not, restructure consumer-scoped rate limit as per-route.

### 2.4 Observability (P1)

- [x] **O-01 | P1 | Add OpenTelemetry SDK to all services** *(done — M6, merged `850b975`)*
  - Services: ALL
  - Fix per language:
    - NestJS (auth, payment): `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`
    - Go (ticket, expiration): `go.opentelemetry.io/otel`, `go.opentelemetry.io/contrib/instrumentation/...`
    - Java (order): `opentelemetry-javaagent` auto-instrumentation JAR
    - Next.js (client): `@vercel/otel` or `@opentelemetry/sdk-node`
  - Export to OTel Collector sidecar.

- [x] **O-02 | P1 | Add traceId/spanId to all structured log output** *(done — M6, merged `850b975`)*
  - Services: ALL
  - Depends on: O-01
  - Fix: Configure each logging framework to extract trace context from OTel context and include `traceId`/`spanId` in every log line.

- [ ] **O-07 | P1 | Make gRPC server observable (duplicate of R-08)**
  - Covered by R-08 above. Ensure gRPC interceptors include OTel trace propagation.

### 2.5 Performance (P1)

- [ ] **P-01 | P1 | Add pagination to ticket-service FindAll**
  - File: `services/ticket-service/internal/repository/mongo_ticket_repository.go:171-186`
  - Fix: Implement cursor-based pagination with `limit` and `after` parameters. Update HTTP handler and gRPC service to accept pagination params.

- [ ] **P-02 | P1 | Add pagination to client homepage**
  - File: `services/client/app/page.tsx:21`
  - Fix: Add `?limit=20&offset=0` support. Implement pagination UI (numbered pages or infinite scroll).

- [ ] **P-03 | P1 | Replace cache: "no-store" with appropriate caching**
  - File: `services/client/lib/api.ts:29`
  - Fix: Use `next: { revalidate: 10 }` for read endpoints (tickets list, ticket detail). Keep `cache: "no-store"` only for user-specific data (current user, orders).

### 2.6 Infrastructure (P1)

- [ ] **I-01 | P1 | Add NetworkPolicy to all Helm sub-charts**
  - Files: All `infra/helm/charts/*/templates/`
  - Fix: Add `networkpolicy.yaml` template to each sub-chart. Example: auth-service allows ingress only from Kong; order-service allows ingress from Kong, egress to ticket-service + Kafka + PostgreSQL.

- [ ] **I-02 | P1 | Add startupProbe for slow-starting services**
  - File: `infra/helm/charts/order-service/values.yaml:43-50`
  - Fix: Add `startupProbe` with `failureThreshold: 30`, `periodSeconds: 5` (150s budget). Reduce liveness `initialDelaySeconds` back to a short value.

- [ ] **I-03 | P1 | Add topologySpreadConstraints for production**
  - Files: All Helm deployment templates
  - Fix: Add `topologySpreadConstraints` with `topology.kubernetes.io/zone` key. Only apply in production (conditional on values).

- [ ] **I-04 | P1 | Replace image.tag: latest with CI-driven tags**
  - File: `infra/helm/values.yaml:17,38,60,87,108,128`
  - Fix: Default to `"SET_BY_CI"`. CI pipelines pass `--set <service>.image.tag=$GITHUB_SHA`.

- [x] **I-12 | P1 | Remove :latest tag from CI push jobs**
  - Files: All `.github/workflows/ci-*.yml`
  - Fix: Remove the `docker push ...:latest` line from all push jobs. Only push `${{ github.sha }}` tag.

### 2.7 Testing (P1)

- [ ] **T-01 | P1 | Add gRPC integration tests for ticket-service**
  - Fix: Test the gRPC server with a real MongoDB (Testcontainers). Cover `GetTicket`, `FindAll`, error cases.

- [ ] **T-02 | P1 | Add Kafka consumer integration tests for ticket-service**
  - Fix: Test `handleOrderCreated` / `handleOrderCancelled` with real Kafka (Testcontainers). Verify ticket reservation/release.

- [ ] **T-07 | P1 | Fix health endpoint tests in expiration-service (currently no-ops)**
  - File: `services/expiration-service/test/integration_test.go:290-302`
  - Fix: Tests currently construct a hardcoded mux, not the real health server. Rewrite to test the actual `server.New()` implementation with real dependency checkers.

---

## Phase 3: P2 Medium — Must Fix Before Production

> **Gate**: All P0 + P1 items verified. All P2 items complete before first production deploy.

### 3.1 Security (P2)

- [ ] **S-04 | P2 | Implement Redis-based JWT blacklist on signout**
  - File: `services/auth-service/src/modules/auth/auth.controller.ts:44-46`
  - Fix: On signout, add the token's `jti` to Redis with TTL = remaining token lifetime. Check blacklist on every auth check.

- [ ] **S-06 | P2 | Derive cookie maxAge from JWT_EXPIRY config**
  - File: `services/auth-service/src/modules/auth/auth.controller.ts:72`
  - Fix: Use `ms()` to parse `JWT_EXPIRY` string, set `maxAge` dynamically.

- [ ] **S-09 | P2 | Set fail-on-unknown-properties: true in order-service**
  - File: `services/order-service/src/main/resources/application.yml:62`

- [ ] **S-10 | P2 | Add UUID format validation to CreateOrderRequest.ticketId**
  - File: `services/order-service/src/main/java/com/ticketing/orders/dto/CreateOrderRequest.java:12`
  - Fix: Add `@Pattern(regexp = "^[0-9a-f]{8}-...")` or add `IllegalArgumentException` handler to `GlobalExceptionHandler`.

- [ ] **S-11 | P2 | Restrict currency field to valid ISO 4217 codes**
  - File: `services/payment-service/src/modules/payments/payments.dto.ts:12-13`
  - Fix: Use `@IsIn(['usd', 'eur', ...])` or at minimum `@MaxLength(3)`.

- [ ] **S-14 | P2 | Add email format validation in client Server Actions**
  - File: `services/client/app/actions/auth.ts:25-26`

- [ ] **S-20 | P2 | Audit Git history for committed .env files**
  - Run: `git log --all --diff-filter=A -- '**/.env'`. If found, consider rotating any exposed credentials.

### 3.2 Correctness (P2)

- [ ] **C-04 | P2 | Distinguish OCC conflict from not-found in ticket-service Update**
  - File: `services/ticket-service/internal/repository/mongo_ticket_repository.go:213`
  - Fix: After `MatchedCount == 0`, do `FindByID`. If exists → `ErrVersionConflict` (409). If not → `ErrTicketNotFound` (404).

- [ ] **C-07 | P2 | Delete dead state machine package in order-service**
  - File: `services/order-service/src/main/java/com/ticketing/orders/statemachine/` (entire package)
  - Remove `@EnableStateMachineFactory` from application class.

- [ ] **C-08 | P2 | Change proto price from double to string (or int64 cents)**
  - File: `proto/tickets/v1/tickets.proto:39`
  - Impact: Requires regenerating stubs and updating all services that consume the proto.

- [ ] **C-09 | P2 | Tighten isAwaitingPayment() to exclude CREATED status**
  - File: `services/order-service/src/main/java/com/ticketing/orders/entity/Order.java:76`
  - Fix: Return `true` only for `AWAITING_PAYMENT`, not for `CREATED`.

- [ ] **C-11 | P2 | Fix STRIPE_SECRET_KEY mock-mode mismatch**
  - Files: `services/payment-service/.env` + `src/modules/payments/payments.service.ts:60`
  - Fix: Align `.env` value to `test_mock` (no `sk_` prefix) or change the comparison.

- [ ] **C-12 | P2 | Fix TICKET_SERVICE_GRPC_PORT default to 50051**
  - Files: `services/order-service/src/main/resources/application.yml:91`, `.env.example:11`

### 3.3 Resilience (P2)

- [ ] **R-02 | P2 | Fix gRPC channel leak on shutdown**
  - File: `services/order-service/src/main/java/com/ticketing/orders/grpc/GrpcClientConfig.java:20`
  - Fix: Set `destroyMethod = "shutdown"` or add `@PreDestroy` handler.

- [ ] **R-06 | P2 | Replace log.Fatal in goroutines with controlled error propagation**
  - Files: `services/ticket-service/cmd/server/main.go:97`, `services/expiration-service/cmd/server/main.go:69-72`
  - Fix: Use errgroup or channel to propagate errors to main goroutine.

- [ ] **R-13 | P2 | Map gRPC status codes to appropriate HTTP codes**
  - File: `services/order-service/src/main/java/com/ticketing/orders/grpc/TicketServiceClient.java:38-42`
  - Fix: Inspect `e.getStatus().getCode()`. Map `UNAVAILABLE` → 503, `INTERNAL` → 500, `NOT_FOUND` → 404, etc.

- [ ] **R-14 | P2 | Add outbox table cleanup job**
  - File: `services/order-service/`
  - Fix: Add `@Scheduled` method that deletes rows where `published = true AND created_at < NOW() - 7 days`.

### 3.4 Observability (P2)

- [ ] **O-03 | P2 | Add custom RED metrics to NestJS services**
  - Files: `services/auth-service/src/modules/metrics/`, `services/payment-service/src/modules/metrics/`
  - Fix: Add `prom-client` histograms for `http_request_duration_seconds` and counters for `http_requests_total`, labeled by `method`, `route`, `status_code`.

- [x] **O-04 | P2 | Register GlobalExceptionFilter via DI for structured logging** *(done — M6, merged `850b975`)*
  - Files: `services/auth-service/src/common/filters/`, `services/payment-service/src/common/filters/`
  - Fix: Register via `APP_FILTER` provider token. Inject `PinoLogger`. Remove `console.error`.

- [ ] **O-06 | P2 | Add all-dependency readiness checks**
  - Services: auth-service, ticket-service, payment-service, expiration-service
  - Fix: Check Kafka, Redis, gRPC upstream connectivity in readiness probes. Return 503 if any dependency is down.

### 3.5 Performance (P2)

- [ ] **P-04 | P2 | Fix duplicate API calls on ticket detail page**
  - File: `services/client/app/tickets/[ticketId]/page.tsx:28-46`
  - Depends on: P-03 (caching fix). Once caching is enabled, Next.js deduplicates automatically.

- [ ] **P-05 | P2 | Decode JWT from cookie instead of HTTP roundtrip for user ID**
  - File: `services/client/app/tickets/[ticketId]/page.tsx:54-61`
  - Fix: Decode the JWT payload (base64) from the cookie to extract user ID. No network call needed.

- [ ] **P-07 | P2 | Add memory metric to HPA definitions**
  - Files: All `infra/helm/charts/*/templates/hpa.yaml`
  - Fix: Add memory utilization as a second scaling metric.

- [ ] **P-08 | P2 | Add loading.tsx Suspense boundaries**
  - Files: `services/client/app/tickets/[ticketId]/`, `app/orders/[orderId]/`, `app/orders/`
  - Fix: Create `loading.tsx` files with skeleton screens for data-heavy routes.

- [ ] **P-11 | P2 | Fix static replicas conflicting with HPA**
  - Files: All `infra/helm/charts/*/templates/deployment.yaml`
  - Fix: Conditionally omit `replicas` when HPA is enabled: `{{- if not .Values.autoscaling.enabled }}`.

### 3.6 Infrastructure (P2)

- [ ] **I-05 | P2 | Add conditional guard on ticket-service envFrom**
  - File: `infra/helm/charts/ticket-service/templates/deployment.yaml:51-53`
  - Fix: Wrap `envFrom` in `{{- if .Values.secretRef }}` like other services.

- [ ] **I-06 | P2 | Add ServiceAccount per service in Helm**
  - Files: All Helm sub-charts
  - Fix: Add `serviceaccount.yaml` template. Reference in deployment spec. Even if IRSA isn't configured yet, it's needed for EKS.

- [ ] **I-13 | P2 | Add concurrency control to CI workflows**
  - Files: All `.github/workflows/`
  - Fix: Add `concurrency: { group: ci-<service>-${{ github.ref }}, cancel-in-progress: true }`.

- [ ] **I-14 | P2 | Eliminate double image build in CI push job**
  - Files: All CI pipelines
  - Fix: Export image as tar artifact in build job, load in push job. Or use a single job.

- [ ] **I-15 | P2 | Create CI pipeline for kong-gateway**
  - File: Create `.github/workflows/ci-kong-gateway.yml`
  - Fix: Run `build.sh` + `validate.sh` per environment. Verify config rendering.

- [ ] **I-16 | P2 | Add proto stub regeneration check to proto CI**
  - File: `.github/workflows/ci-proto.yml`
  - Fix: Add `make proto` step followed by `git diff --exit-code` to detect stale stubs.

- [ ] **I-17 | P2 | Fix .env indentation in E2E workflow**
  - File: `.github/workflows/e2e.yml:29-31`
  - Fix: Remove leading whitespace from heredoc body lines.

- [ ] **I-18 | P2 | Add KONG_RSA_PUBLIC_KEY to E2E workflow**
  - File: `.github/workflows/e2e.yml:28-31`
  - Fix: Derive public key from private key and set both env vars.

- [ ] **I-20 | P2 | Create S3 state backend bootstrap script**
  - File: Create `infra/scripts/bootstrap-state.sh`
  - Fix: Script that creates S3 bucket + DynamoDB lock table for Terraform state.

- [ ] **I-21 | P2 | Add TLS termination config to Kong Terraform module**
  - File: `infra/terraform/modules/kong/main.tf`
  - Fix: Add ACM certificate resource and NLB HTTPS listener.

- [ ] **I-22 | P2 | Create Terraform CI/CD pipeline**
  - File: Create `.github/workflows/ci-terraform.yml`
  - Fix: `terraform fmt -check` + `terraform validate` + `terraform plan` (no apply in CI without approval).

### 3.7 Code Quality (P2)

- [ ] **DRY-01 | P2 | Extract shared RSA key parsing in auth-service**
  - Files: `services/auth-service/src/modules/auth/auth.module.ts:16-18`, `auth.service.ts:40-42`
  - Fix: Create a shared utility function or provider that parses the RSA key once.

- [ ] **DRY-02 | P2 | Extract shared base()/authHeaders() in client Server Actions**
  - Files: `services/client/app/actions/auth.ts`, `actions/tickets.ts`, `actions/orders.ts`
  - Fix: Move to a shared `lib/server-utils.ts` file.

- [ ] **D-01 | P2 | Delete dead state machine package** (same as C-07)

- [ ] **D-05 | P2 | Remove dead clientApi (axios) export**
  - File: `services/client/lib/api.ts:43-49`
  - Also remove `axios` from `package.json` dependencies.

- [ ] **CV-01 | P2 | Fix go.mod Go version (1.25 doesn't exist)**
  - Files: `services/ticket-service/go.mod:3`, `services/expiration-service/go.mod:3`
  - Fix: Change to `go 1.23` (or the actual Go version in use).

- [ ] **CV-05 | P2 | Fix EXPOSE port mismatch in expiration-service Dockerfile**
  - File: `services/expiration-service/Dockerfile:23`
  - Fix: Change `EXPOSE 8083` to `EXPOSE 8080` (or whatever `PORT` env var defaults to).

### 3.8 Testing (P2)

- [ ] **T-03 | P2 | Add Kafka consumer integration tests to order-service**
  - Fix: Test payment/ticket/expiration event handling with real Kafka (Testcontainers).

- [ ] **T-04 | P2 | Add Kafka consumer integration tests to payment-service**
  - Fix: Include `OrdersConsumer` in the test module. Test with real Kafka.

- [ ] **T-05 | P2 | Add unit tests for client Server Actions**
  - Fix: Test validation logic and cookie handling in `auth.ts`, `tickets.ts`, `orders.ts`.

- [ ] **T-08 | P2 | Add concurrent OCC conflict test to ticket-service**
  - Fix: Two goroutines update the same ticket simultaneously. Verify one succeeds and one gets a version conflict.

- [ ] **T-10 | P2 | Fix auth-service integration test isolation**
  - File: `services/auth-service/test/auth.integration.spec.ts`
  - Fix: Use per-test transaction rollback or truncate tables in `beforeEach`.

- [ ] **T-11 | P2 | Replace os.Unsetenv with t.Setenv in Go config tests**
  - Files: `services/ticket-service/internal/config/config_test.go`, `services/expiration-service/...`

- [ ] **T-12 | P2 | Replace time.Sleep with polling assertions in expiration tests**
  - File: `services/expiration-service/test/integration_test.go:156,181,204`

- [ ] **T-13 | P2 | Remove fixed host port for Kafka in expiration tests**
  - File: `services/expiration-service/test/integration_test.go:65`
  - Fix: Use dynamic port assignment from Testcontainers.

- [ ] **T-14 | P2 | Improve client component test mocking strategy**
  - Files: `services/client/__tests__/*.test.tsx`
  - Fix: Test actual form submission instead of mocking `useActionState` at module level.

---

## Phase 4: P3 Low — Tech Debt Backlog

> Not blocking any deployment. Address when convenient or during dedicated tech debt sprints.

### 4.1 Security (P3)

- [ ] **S-12 | P3 | Add UUID format validation on ticket-service path params**
- [ ] **S-13 | P3 | Use utf8.RuneCountInString() for title length validation**
- [ ] **S-21 | P3 | Add packageManager field to all Node.js package.json files**

### 4.2 Correctness (P3)

- [ ] **C-10 | P3 | Fix drizzle.config.ts output directory mismatch**

### 4.3 Resilience (P3)

- [ ] **R-10 | P3 | Fix quadratic backoff to exponential with jitter in expiration-service**

### 4.4 Observability (P3)

- [ ] **O-05 | P3 | Add service field to ticket-service/expiration-service logger**
- [ ] **O-08 | P3 | Parse traceparent header to extract just trace ID**
- [ ] **O-09 | P3 | Replace console.log in migrate.ts with standalone Pino instance**

### 4.5 Performance (P3)

- [ ] **P-06 | P3 | Replace JOIN FETCH with existsBy query in order-service**
- [ ] **P-09 | P3 | Remove unused axios dependency from client**
- [ ] **P-10 | P3 | Fix Docker layer caching for Go services**

### 4.6 Infrastructure (P3)

- [ ] **I-07 | P3 | Add _helpers.tpl to all Helm sub-charts**
- [ ] **I-08 | P3 | Wire global.imageRegistry into deployment templates or remove it**
- [ ] **I-09 | P3 | Add explicit RollingUpdate strategy to deployments**
- [ ] **I-10 | P3 | Add NOTES.txt to Helm sub-charts**

### 4.7 Code Quality (P3)

- [ ] **D-02 | P3 | Remove unused NON_TERMINAL_STATUSES constant (order-service)**
- [ ] **D-03 | P3 | Delete app.e2e-spec.ts scaffold test (auth-service)**
- [ ] **D-04 | P3 | Delete jest-e2e.json config (auth-service uses Vitest)**
- [ ] **D-06 | P3 | Remove unused jwks-rsa dependency (auth-service)**
- [ ] **D-07 | P3 | Remove unused @nestjs/microservices dependency (payment-service)**
- [ ] **D-08 | P3 | Remove unused source-map-support, ts-loader dev deps (auth-service)**
- [ ] **D-09 | P3 | Move pino-pretty to devDependencies (payment-service)**
- [ ] **D-10 | P3 | Remove unused COOKIE_DOMAIN from Joi schema (auth-service)**
- [ ] **D-11 | P3 | Remove unused TopicExpirationCompleteDLQ constant** (fixed by R-04)
- [ ] **D-12 | P3 | Remove unused ConflictException import (payment-service)**
- [ ] **D-13 | P3 | Replace Jest globals with Vitest in ESLint config (auth, payment)**
- [ ] **DRY-03 | P3 | Extract shared broker string join logic (ticket-service)**
- [ ] **DRY-04 | P3 | Extract shared status config maps (client)**
- [ ] **DRY-05 | P3 | Extract shared fullName computation in Helm templates**
- [ ] **CV-02 | P3 | Add engines/packageManager field to Node.js package.json files** (same as S-21)
- [ ] **CV-03 | P3 | Rename DLQ suffix from .DLT to .dlq (order-service)**
- [ ] **CV-04 | P3 | Move gRPC stubs from ticket-service to /libs/**
- [ ] **CV-06 | P3 | Remove go mod tidy from Dockerfiles**
- [ ] **CV-07 | P3 | Remove duplicate CHECK constraint in payment migration**

### 4.8 Testing (P3)

- [ ] **T-06 | P3 | Add unit tests for client Server Components / pages**
- [ ] **T-09 | P3 | Add controller unit tests for auth-service**
- [ ] **T-15 | P3 | Improve StubTicketService to return realistic data (order-service)**
- [ ] **T-16 | P3 | Fix PG_POOL import in auth-service integration test**

---

## Summary by Phase

| Phase | Items | Severity | Gate |
|-------|-------|----------|------|
| **Phase 1** | 10 | P0 Critical | Must complete before staging |
| **Phase 2** | 22 | P1 High | Must complete before staging deploy |
| **Phase 3** | 28 | P2 Medium | Must complete before production deploy |
| **Phase 4** | 15 | P3 Low | Backlog — no deployment gate |

## Estimated Effort

| Phase | Estimated effort | Notes |
|-------|-----------------|-------|
| Phase 1 | 3-5 days | Heaviest items: outbox fix, payment producer, DLQ implementation, CI deploy stages |
| Phase 2 | 5-8 days | OTel integration is the single biggest item (~2 days across all services) |
| Phase 3 | 4-6 days | Mostly straightforward fixes; testing items are the most time-consuming |
| Phase 4 | 2-3 days | All items are quick individual fixes |
| **Total** | **14-22 days** | For a single engineer working full-time |

---

*Cross-reference every item with [AUDIT-REPORT.md](./AUDIT-REPORT.md) for full context, file:line references, and detailed recommendations.*
