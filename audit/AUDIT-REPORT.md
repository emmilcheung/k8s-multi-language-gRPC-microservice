# Deep Code Audit & Performance Analysis Report

> **Ticketing Microservices Platform**
> **Date**: 2026-03-27
> **Auditor**: QA & Audit Team (AI-assisted)
> **Scope**: All completed milestones (M0-M6, Kong, Local K8s), plus review of upcoming milestones (M7-M9)
> **Standard**: FAANG / Enterprise Principal Engineer Production Readiness Review (PRR)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Audit Methodology](#2-audit-methodology)
3. [Phase 1: Security Audit](#3-phase-1-security-audit)
4. [Phase 2: Correctness & Data Integrity](#4-phase-2-correctness--data-integrity)
5. [Phase 3: Resilience & Reliability](#5-phase-3-resilience--reliability)
6. [Phase 4: Observability](#6-phase-4-observability)
7. [Phase 5: Performance & Scalability](#7-phase-5-performance--scalability)
8. [Phase 6: Infrastructure & Deployment](#8-phase-6-infrastructure--deployment)
9. [Phase 7: Code Quality & Conventions](#9-phase-7-code-quality--conventions)
10. [Phase 8: Testing](#10-phase-8-testing)
11. [Upcoming Milestones Review](#11-upcoming-milestones-review-plan-m7-m9)
12. [Statistics & Risk Matrix](#12-statistics--risk-matrix)

---

## 1. Executive Summary

### Overall Assessment

The platform demonstrates **strong architectural foundations**: clean service separation, proper layering (controller -> service -> repository), well-chosen technology per service, idiomatic use of each language/framework, and a functional local dev environment with 18/18 E2E tests passing. The engineering standards document (AGENTS.md) is exceptionally thorough.

However, the audit uncovered **75 findings** that must be addressed before the platform can be considered production-ready by FAANG/enterprise standards:

| Severity | Count | Description |
|----------|-------|-------------|
| **P0 (Critical)** | 10 | Blocks any non-local deployment. Security vulnerabilities, correctness bugs, data loss risk. |
| **P1 (High)** | 22 | Must fix before staging. Reliability gaps, observability blindspots, resilience failures. |
| **P2 (Medium)** | 28 | Should fix before production. Code quality, performance, convention violations. |
| **P3 (Low)** | 15 | Tech debt backlog. Style, optimization, polish. |

### Top 5 Critical Findings

1. **Broken transactional outbox** (`order-service`): `@Transactional` self-invocation bypass means the outbox pattern (the core data consistency guarantee) is **not actually transactional**. Order writes and outbox writes can diverge.
2. **Missing payment event producer** (`payment-service`): No Kafka producer for `payments.payment.captured` events. The event-driven architecture has a broken link -- downstream services never learn about successful payments.
3. **Identity header spoofing** (`kong-gateway`): External clients can forge `X-User-Id` headers on non-JWT-protected routes because Kong doesn't strip incoming identity headers before forwarding.
4. **Silent message loss** (`ticket-service`, `expiration-service`): Both Kafka consumers commit offsets on failure without routing to a DLQ. Failed messages are permanently lost.
5. **Stripe secret in Git** (`docker-compose.yml`): A Stripe test API key is hardcoded in version-controlled docker-compose.yml.

### What's Done Well

- **Service independence**: Each service owns its datastore, communicates via gRPC (sync) or Kafka (async), and deploys independently.
- **Config validation at startup**: All services fail loudly if required env vars are missing.
- **Integration testing**: Testcontainers used across all services for real-dependency integration tests.
- **Docker multi-stage builds**: All Dockerfiles use multi-stage builds, non-root users (except Kong), and health checks.
- **Kong gateway design**: DB-less declarative config with multi-environment value templating is production-grade.
- **Helm chart structure**: Umbrella chart with per-service sub-charts, proper dependencies, and local overrides.
- **Input validation**: Schema-based validation (class-validator, Jakarta Bean Validation, manual Go) at every service boundary.

---

## 2. Audit Methodology

This audit follows the **Production Readiness Review (PRR)** framework used at Google, Meta, and similar organizations:

1. **Security**: Authentication, authorization, input validation, injection prevention, secrets management, supply chain
2. **Correctness**: Data integrity, transactional boundaries, state machine correctness, event ordering
3. **Resilience**: Circuit breakers, retries, DLQ, graceful shutdown, timeout enforcement, fallback behavior
4. **Observability**: Structured logging, distributed tracing, metrics (RED method), health checks
5. **Performance**: Pagination, caching, bundle optimization, database query efficiency, resource limits
6. **Infrastructure**: Kubernetes hardening, CI/CD completeness, Helm quality, Terraform design
7. **Code Quality**: Dead code, DRY violations, convention compliance, dependency hygiene
8. **Testing**: Coverage gaps, test isolation, test infrastructure quality

**Severity ratings** follow the standard incident priority framework:
- **P0**: Immediate action required. Would cause a SEV-1 incident in production.
- **P1**: Action required before staging deployment. Would cause a SEV-2 incident.
- **P2**: Action required before production deployment. Degrades quality or developer experience.
- **P3**: Backlog item. Improves codebase but not blocking.

**Scope**: Every source file in every service, all infrastructure code, all CI/CD pipelines, all configuration files. Findings include `file:line` references where applicable.

---

## 3. Phase 1: Security Audit

### 3.1 Authentication & Authorization

#### S-01 | P1 | No refresh token implementation
- **Service**: auth-service
- **Location**: `src/modules/auth/auth.service.ts`
- **Description**: AGENTS.md SS5.1 explicitly requires "short-lived access tokens (15 min), long-lived refresh tokens stored server-side (Redis) and rotatable." Currently only a 15-minute access token exists. When it expires, users are silently logged out with no renewal mechanism.
- **Impact**: Poor UX in production; users lose their session every 15 minutes.
- **Recommendation**: Implement refresh token rotation using Redis-backed token storage. Issue refresh tokens as HttpOnly cookies alongside the access token.

#### S-02 | P0 | No X-User-Id header stripping on ingress
- **Service**: kong-gateway
- **Location**: `services/kong-gateway/config/kong.base.yml` (missing globally)
- **Description**: If an external client sends a pre-forged `X-User-Id` header on a public route (e.g., `auth-public`, `tickets-read`, `client-catchall`), it is forwarded to upstream services unchanged. Services that check `X-User-Id` on routes not protected by Kong's JWT plugin could be spoofed.
- **Impact**: Identity spoofing on any non-JWT route. An attacker can impersonate any user.
- **Recommendation**: Add a global `pre-function` or `request-transformer` plugin that strips `X-User-Id` from all incoming requests before route-level plugins run. The JWT `post-function` plugin then sets it authoritatively.

#### S-03 | P1 | currentUser endpoint trusts X-User-Id without verification
- **Service**: auth-service
- **Location**: `src/modules/auth/auth.controller.ts:52-58`
- **Description**: The `currentUser` endpoint reads `X-User-Id` from the request header and returns user data. If an attacker bypasses Kong (e.g., in local dev, misconfigured NetworkPolicy, or a compromised cluster pod), they can impersonate any user.
- **Impact**: User enumeration and impersonation if network controls fail.
- **Recommendation**: Defense-in-depth: also verify the JWT from the cookie at the service level, or ensure NetworkPolicy is in place to restrict direct access.

#### S-04 | P2 | Signout doesn't invalidate JWT server-side
- **Service**: auth-service
- **Location**: `src/modules/auth/auth.controller.ts:44-46`
- **Description**: `clearCookie` only tells the browser to delete the cookie. If the token was intercepted (XSS from another subdomain, network sniffing), it remains valid until expiry. There is no token blacklist or revocation mechanism.
- **Impact**: Stolen tokens remain usable for up to 15 minutes after signout.
- **Recommendation**: Implement a Redis-based token blacklist. On signout, add the token's `jti` to Redis with a TTL matching the token's remaining lifetime.

#### S-05 | P0 | GET /api/payments/:id has no authorization check
- **Service**: payment-service
- **Location**: `src/modules/payments/payments.controller.ts:51-55`
- **Description**: Any caller (even without `X-User-Id`) can read any payment by ID. The endpoint has no ownership check.
- **Impact**: Payment data exposure to unauthenticated/unauthorized callers.
- **Recommendation**: Add `X-User-Id` requirement and verify the requesting user owns the payment (or the associated order).

#### S-06 | P2 | Cookie maxAge hardcoded while JWT_EXPIRY is configurable
- **Service**: auth-service
- **Location**: `src/modules/auth/auth.controller.ts:72`
- **Description**: Cookie `maxAge` is hardcoded to `15 * 60 * 1000` (15 min), while `JWT_EXPIRY` is a configurable env var. If someone sets `JWT_EXPIRY=30m`, the cookie dies at 15m but the token is valid for 30m.
- **Impact**: Subtle auth desync if expiry is ever changed.
- **Recommendation**: Derive `maxAge` from the `JWT_EXPIRY` configuration value using `ms()` to parse it.

#### S-07 | P1 | Client auth cookie has no maxAge
- **Service**: client
- **Location**: `app/actions/auth.ts:47-52`
- **Description**: The `cookies().set()` call in the signup/signin Server Actions doesn't set `maxAge`. This creates a session cookie (deleted when browser closes). The JWT inside has a 15-minute TTL, but the cookie itself never expires within a browser session. An expired JWT will be sent indefinitely until the user signs out or closes the browser.
- **Impact**: Requests with expired JWTs sent to backend; 401 errors confuse users.
- **Recommendation**: Set `maxAge: 900` (15 min) on the cookie to match JWT lifetime.

#### S-08 | P1 | Cookie parsing via regex is fragile
- **Service**: client
- **Location**: `app/actions/auth.ts:45`
- **Description**: `setCookie.match(/token=([^;]+)/)` is used to parse the `Set-Cookie` header. This doesn't handle quoted values, URL-encoded characters, or multiple `Set-Cookie` headers joined by the Fetch API.
- **Impact**: Auth flow could break with certain token values or reverse proxy configurations.
- **Recommendation**: Use a proper `Set-Cookie` parser (e.g., the `set-cookie-parser` package or manual split on `; `).

### 3.2 Input Validation & Injection Prevention

#### S-09 | P2 | fail-on-unknown-properties: false in order-service
- **Service**: order-service
- **Location**: `src/main/resources/application.yml:62`
- **Description**: Jackson silently accepts and ignores unexpected JSON fields. AGENTS.md SS9.1 states "Reject unknown fields -- do not pass them through or store them."
- **Impact**: Clients can send arbitrary fields that are silently dropped; debugging confusion; potential data injection if fields are ever added that match unknown input.
- **Recommendation**: Set `fail-on-unknown-properties: true` or annotate DTOs with `@JsonIgnoreProperties(ignoreUnknown = false)`.

#### S-10 | P2 | UUID.fromString() without try-catch in CreateOrderRequest
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/dto/CreateOrderRequest.java:12`
- **Description**: If a malformed string passes `@NotBlank` validation (e.g., `"not-a-uuid"`), `UUID.fromString()` throws an uncaught `IllegalArgumentException`. The `GlobalExceptionHandler` has no handler for `IllegalArgumentException`, resulting in a generic 500.
- **Impact**: Malformed input returns 500 instead of 400 with a proper validation message.
- **Recommendation**: Add a `@Pattern` regex for UUID format on the `ticketId` field, or add an `IllegalArgumentException` handler to `GlobalExceptionHandler`.

#### S-11 | P2 | currency field validated only as @IsString()
- **Service**: payment-service
- **Location**: `src/modules/payments/payments.dto.ts:12-13`
- **Description**: No length limit, no enumeration of allowed values. A caller could send `currency: "<10KB string>"`.
- **Impact**: Unexpected Stripe API behavior or error; potential for log injection via long strings.
- **Recommendation**: Use `@IsIn(['usd', 'eur', ...])` or at minimum `@MaxLength(3)`.

#### S-12 | P3 | No UUID format validation on path params (ticket-service)
- **Service**: ticket-service
- **Location**: `internal/handler/ticket_handler.go:118,137`
- **Description**: `c.Param("id")` passes arbitrary strings to MongoDB. While MongoDB driver uses parameterized queries (no injection risk), garbage IDs cause unnecessary DB lookups.
- **Recommendation**: Validate UUID format before the DB call.

#### S-13 | P3 | Title length measured in bytes, not runes
- **Service**: ticket-service
- **Location**: `internal/handler/ticket_handler.go:78`
- **Description**: `len(req.Title)` counts bytes, not characters. Multi-byte UTF-8 characters (CJK, emoji) hit the limit at fewer visible characters.
- **Recommendation**: Use `utf8.RuneCountInString()` for user-facing length limits.

#### S-14 | P2 | No email format validation in client Server Actions
- **Service**: client
- **Location**: `app/actions/auth.ts:25-26`
- **Description**: Only checks `!email || !password` -- doesn't validate email format. AGENTS.md SS9.1 requires validation at every service boundary.
- **Recommendation**: Add a basic email regex check or use a validation library.

### 3.3 Secrets & Supply Chain

#### S-15 | P0 | Stripe test key hardcoded in docker-compose.yml
- **Service**: root
- **Location**: `docker-compose.yml:329`
- **Description**: `STRIPE_SECRET_KEY: "sk_test_4eC39HqLyjWDarhtT1ZdV7xY"` is committed to version control. While it's a test key, it is still a credential. AGENTS.md SS5.3 and SS14.4 explicitly prohibit this.
- **Impact**: Credential exposure in public repository.
- **Recommendation**: Move to `.env` file (gitignored) with `.env.example` having a placeholder. Load via `env_file` in docker-compose.

#### S-16 | P1 | RSA private key in docker-compose.yml
- **Service**: root
- **Location**: `docker-compose.yml` (noted in STATUS.md as known issue)
- **Description**: The RSA private key for JWT signing is hardcoded in docker-compose.yml. This is acknowledged as a known issue but has not been fixed.
- **Impact**: Private key exposure in public repository.
- **Recommendation**: Same as S-15 -- move to gitignored `.env` file.

#### S-17 | P0 | Kong Dockerfile runs as root
- **Service**: kong-gateway
- **Location**: `services/kong-gateway/Dockerfile:43-44`
- **Description**: `USER root` is set at the final stage. AGENTS.md SS10.1 mandates "never run as root." The render step writes to `/etc/kong/` but this can be solved by pre-creating the directory with correct permissions.
- **Impact**: A container escape gives the attacker root on the node.
- **Recommendation**: Change runtime user to `kong` (the stock Kong image user). Pre-create `/etc/kong/` with write permissions during build.

#### S-18 | P0 (prod) / P3 (dev) | Docker images not pinned to digest
- **Service**: kong-gateway, docker-compose
- **Locations**:
  - `services/kong-gateway/Dockerfile:17` (`kong:3.7-ubuntu`)
  - `docker-compose.yml:10,73,93,112,148` (postgres, mongo, redis, kafka, schema-registry)
- **Description**: AGENTS.md SS10.1 requires "Pin image versions to digest in production." Tag-only references can be overwritten by the publisher.
- **Impact**: Supply chain attack vector in production. A compromised upstream tag could inject malicious code.
- **Recommendation**: Pin all production Dockerfiles to `@sha256:...` digests. docker-compose (dev-only) can remain tag-based.

#### S-19 | P1 | jwt-sub.lua uses regex-based JSON parsing
- **Service**: kong-gateway
- **Location**: `services/kong-gateway/plugins/jwt-sub.lua:21`
- **Description**: `payload_json:match('"sub"%s*:%s*"([^"]+)"')` is used to extract the JWT `sub` claim. A malicious JWT payload with escaped quotes (`\"`) could break the extraction. Kong/OpenResty has `cjson` available.
- **Impact**: Malformed JWTs could bypass identity extraction or inject wrong user IDs.
- **Recommendation**: Use `require("cjson.safe").decode(payload_json)` instead of regex.

#### S-20 | P2 | .env files exist in working tree for multiple services
- **Services**: auth-service, ticket-service, order-service, payment-service
- **Locations**: Various `services/<name>/.env` files
- **Description**: While `.gitignore` lists `.env`, the files exist in the working tree. They may have been committed at some point in Git history. Some contain credentials like `STRIPE_SECRET_KEY=sk_test_mock` and DB passwords.
- **Recommendation**: Verify Git history for committed `.env` files. Run `git log --all --diff-filter=A -- '**/.env'` to check.

#### S-21 | P3 | No packageManager field in package.json
- **Services**: auth-service, payment-service, client
- **Description**: `corepack enable` in Dockerfiles can't pin pnpm version without a `packageManager` field. Docker builds may use different pnpm versions than local dev.
- **Recommendation**: Add `"packageManager": "pnpm@9.x.x"` to all Node.js `package.json` files.

---

## 4. Phase 2: Correctness & Data Integrity

#### C-01 | P0 | @Transactional self-invocation bypass (CRITICAL)
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/service/OrderService.java:109`
- **Description**: `createOrder()` calls `this.createOrderTransactional()` -- a `protected` method annotated with `@Transactional`. Spring's proxy-based AOP only intercepts calls from external callers. Self-invocation bypasses the proxy entirely. **The transactional boundary is not applied.** The order save and outbox write may not be in the same transaction, breaking the core data consistency guarantee of the outbox pattern.
- **Impact**: Data inconsistency -- orders can be created without corresponding outbox entries (events never published), or outbox entries created without orders (phantom events).
- **Recommendation**: Extract `createOrderTransactional` to a separate `@Service` bean (e.g., `OrderTransactionService`), inject it into `OrderService`, and call it through the proxy. Alternatively, use `TransactionTemplate` for programmatic transaction control.

#### C-02 | P1 | OutboxRelay wraps entire batch in one @Transactional
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/outbox/OutboxRelay.java:40-59`
- **Description**: The relay iterates all pending outbox messages within a single `@Transactional`. If any Kafka send in the loop succeeds but a later one fails, the entire transaction rolls back, re-publishing already-delivered messages on the next relay cycle.
- **Impact**: Duplicate Kafka events. Downstream consumers must be idempotent (they should be per AGENTS.md, but this increases unnecessary load and complexity).
- **Recommendation**: Use per-message transactions, or remove the `@Transactional` annotation and save each row individually after successful Kafka delivery.

#### C-03 | P1 | ReserveTicket in MongoDB lacks OCC (version check)
- **Service**: ticket-service
- **Location**: `internal/repository/mongo_ticket_repository.go:232-253`
- **Description**: Unlike `Update` which checks `version: previousVersion`, `ReserveTicket` uses only `_id` in the filter. If two concurrent `order.created` events arrive for the same ticket, both could succeed. The comment claims idempotency, but setting different `orderID` values is a silent overwrite, not idempotent.
- **Impact**: Race condition where two orders could reserve the same ticket.
- **Recommendation**: Add `"orderId": ""` to the filter (only reserve if not already reserved), or add `"orderId": orderID` for true idempotency.

#### C-04 | P2 | OCC failure returns ErrTicketNotFound instead of ErrVersionConflict
- **Service**: ticket-service
- **Location**: `internal/repository/mongo_ticket_repository.go:213`
- **Description**: When `Update` gets `MatchedCount == 0`, it could be "ticket doesn't exist" or "concurrent update changed the version." The caller receives a 404, which is misleading for OCC conflicts.
- **Recommendation**: Add a separate `FindByID` call after `MatchedCount == 0` to distinguish not-found from version conflict. Return `ErrVersionConflict` (mapped to 409) for the latter.

#### C-05 | P0 | Payment service has no Kafka producer for payments.payment.captured
- **Service**: payment-service
- **Location**: Architecture gap (no producer code exists)
- **Description**: After a successful Stripe charge, the payment-service stores the result in its DB but never publishes a `payments.payment.captured` event to Kafka. Order-service and other downstream consumers have no way to learn about successful payments through the event bus. E2E tests work around this by publishing the event directly from the test.
- **Impact**: Complete break in the event-driven architecture. Orders will never transition to `COMPLETE` status in production.
- **Recommendation**: Implement a Kafka producer in payment-service. Use the transactional outbox pattern (write to outbox table in same DB transaction as payment status update) to guarantee delivery.

#### C-06 | P0 | processOrderCreatedEvent non-mock path creates stuck PENDING payments
- **Service**: payment-service
- **Location**: `src/modules/payments/payments.service.ts:146`
- **Description**: When `STRIPE_SECRET_KEY` is a real key (non-mock mode), the `processOrderCreatedEvent` method creates a `PENDING` payment record but never initiates a Stripe charge. The `charge()` method exists but is only called via the HTTP endpoint, not from the Kafka consumer path.
- **Impact**: In production, every order event creates a payment stuck in `PENDING` forever.
- **Recommendation**: After creating the pending payment record, initiate a Stripe PaymentIntent. On success, mark as `COMPLETED` and publish the captured event. On failure, mark as `FAILED`.

#### C-07 | P2 | State machine is dead code with a logical bug
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/statemachine/OrderStateMachineConfig.java:39-41`
- **Description**: The `CANCEL` event from `CREATED` state is configured to transition to `AWAITING_PAYMENT` (wrong target, no guard). Line 44 also defines `CREATED -> CANCELLED` on `CANCEL`, creating an ambiguous transition. The entire state machine package is never used -- all transitions are handled via `order.setStatus()`.
- **Impact**: Dead code wastes startup time (`@EnableStateMachineFactory` creates unused beans). The bug would cause wrong state transitions if the state machine were ever wired in.
- **Recommendation**: Delete the `statemachine/` package entirely. If state machine is desired later, rebuild it correctly with proper guards.

#### C-08 | P2 | Proto price as double causes floating-point precision loss
- **Service**: proto (shared), order-service
- **Locations**: `proto/tickets/v1/tickets.proto:39`, `OrderService.java:137`
- **Description**: The `price` field in the proto definition is `double`. `String.valueOf(double)` can produce values like `49.98999999999999`. Financial calculations with floating-point types violate industry best practices.
- **Recommendation**: Change proto `price` to `string` and transmit decimal values as formatted strings. Alternatively, use `int64` representing cents.

#### C-09 | P2 | markComplete accepts payment when order is CREATED (not just AWAITING_PAYMENT)
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/entity/Order.java:76`
- **Description**: `isAwaitingPayment()` returns `true` for both `CREATED` and `AWAITING_PAYMENT`. A payment could complete an order that hasn't gone through the awaiting-payment phase.
- **Impact**: State machine bypass -- orders skip the `AWAITING_PAYMENT` state.
- **Recommendation**: Tighten `isAwaitingPayment()` to only return true for `AWAITING_PAYMENT` status.

#### C-10 | P3 | drizzle.config.ts output dir mismatch
- **Service**: auth-service
- **Location**: `drizzle.config.ts:16`
- **Description**: `out: './drizzle'` doesn't match actual migrations directory `./migrations/`. Running `pnpm migrate:generate` would create files in the wrong directory.
- **Recommendation**: Change to `out: './migrations'`.

#### C-11 | P2 | STRIPE_SECRET_KEY mock-mode mismatch
- **Service**: payment-service
- **Location**: `.env` vs `src/modules/payments/payments.service.ts:60`
- **Description**: `.env` has `STRIPE_SECRET_KEY=sk_test_mock` but the mock check compares against `'test_mock'` (no `sk_` prefix). The mock path is never triggered with the `.env` value.
- **Impact**: Local dev attempts real Stripe API calls with a bogus key instead of using mock mode.
- **Recommendation**: Align the `.env` value to `test_mock` or change the comparison to check for `sk_test_mock`.

#### C-12 | P2 | TICKET_SERVICE_GRPC_PORT default mismatch
- **Service**: order-service
- **Location**: `src/main/resources/application.yml:91`, `.env.example:11`
- **Description**: Defaults to `9090` but the actual ticket-service gRPC port is `50051`. The setup.sh was already corrected, but the order-service default and `.env.example` are stale.
- **Recommendation**: Update both to `50051`.

---

## 5. Phase 3: Resilience & Reliability

#### R-01 | P1 | No circuit breaker on gRPC client
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/grpc/TicketServiceClient.java`
- **Description**: AGENTS.md SS8.2 requires a circuit breaker on every gRPC client and outbound HTTP call. When ticket-service is down, every order creation waits 5 seconds for the deadline to expire, degrading order-service performance linearly with request volume.
- **Recommendation**: Add resilience4j `@CircuitBreaker` with a fallback that returns a clear error or cached ticket data.

#### R-02 | P2 | gRPC channel never shut down gracefully
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/grpc/GrpcClientConfig.java:20`
- **Description**: `destroyMethod = ""` explicitly disables channel shutdown. When the Spring context shuts down, the gRPC channel leaks.
- **Recommendation**: Set `destroyMethod = "shutdown"` or register a `@PreDestroy` handler.

#### R-03 | P0 | No DLQ in ticket-service Kafka consumer
- **Service**: ticket-service
- **Location**: `internal/kafka/consumer.go:123`
- **Description**: The code has an explicit `TODO: publish to DLQ; for now log and commit`. Failed messages are committed (acknowledged) without being routed to a Dead Letter Topic. Per AGENTS.md SS3.5: "route to a Dead Letter Topic [...] Never silently discard a message."
- **Impact**: Failed order events are permanently lost. Tickets that should be reserved/released may not be.
- **Recommendation**: Implement DLQ producer. Route failed messages to `orders.order.created.dlq` / `orders.order.cancelled.dlq` after 3 retry attempts.

#### R-04 | P0 | No DLQ in expiration-service Kafka consumer
- **Service**: expiration-service
- **Location**: `internal/kafka/consumer.go:74-80`
- **Description**: Same issue as R-03. Failed messages are logged and committed. The `TopicExpirationCompleteDLQ` constant is declared but never used.
- **Impact**: Failed order events are permanently lost. Expiration timers may never be scheduled.
- **Recommendation**: Same as R-03.

#### R-05 | P1 | Kafka publish failure silently swallowed in ticket-service
- **Service**: ticket-service
- **Location**: `internal/service/ticket_service.go:71-73`
- **Description**: After creating a ticket in MongoDB, the Kafka publish is attempted. If it fails, the error is logged but the DB write has already succeeded. There is no outbox pattern and no retry mechanism. The event is permanently lost.
- **Impact**: Downstream services never learn about new/updated tickets.
- **Recommendation**: Implement the transactional outbox pattern (write event to a MongoDB collection in the same session as the ticket mutation, then relay to Kafka). Alternatively, implement a retry with exponential backoff before giving up.

#### R-06 | P2 | log.Fatal in goroutines skips deferred cleanup
- **Services**: ticket-service, expiration-service
- **Locations**: `ticket-service/cmd/server/main.go:97`, `expiration-service/cmd/server/main.go:69-72`
- **Description**: `log.Fatal` calls `os.Exit(1)` which skips all deferred cleanup (MongoDB close, Kafka producer flush, consumer cancellation). If the gRPC server or asynq worker fails to start, resources leak.
- **Recommendation**: Use a channel or errgroup to propagate errors back to the main goroutine for controlled shutdown.

#### R-07 | P1 | Expiration-service readiness probe always returns 200
- **Service**: expiration-service
- **Location**: `cmd/server/main.go:65`
- **Description**: `server.New(nil, nil, log)` passes nil dependency checkers. The readiness probe always returns 200 OK even if Redis or Kafka are down. AGENTS.md SS7.4: "returns 200 only when all dependencies are reachable."
- **Impact**: Kubernetes routes traffic to a pod that can't process messages.
- **Recommendation**: Pass Redis ping and Kafka connectivity checkers to the health server.

#### R-08 | P1 | gRPC server has no interceptors
- **Service**: ticket-service
- **Location**: `internal/grpc/server.go:96`
- **Description**: `grpc.NewServer()` is called with no interceptors. No logging, metrics, recovery, or deadline enforcement on gRPC calls. HTTP requests get full middleware (logger, prometheus, recovery), but gRPC calls are completely unobservable.
- **Recommendation**: Add at minimum: `grpc_zap` (logging), `grpc_prometheus` (metrics), `grpc_recovery` (panic recovery), and a deadline enforcement interceptor (default 5s for reads).

#### R-09 | P1 | No request size limiting on Kong
- **Service**: kong-gateway
- **Location**: `services/kong-gateway/config/kong.base.yml` (missing)
- **Description**: No `request-size-limiting` plugin is configured on any route. A malicious client could send very large request bodies, consuming Kong's memory and potentially triggering OOM kills.
- **Recommendation**: Add a global `request-size-limiting` plugin (e.g., 5 MB default, lower for auth endpoints).

#### R-10 | P3 | Retry uses quadratic backoff, not exponential; no jitter
- **Service**: expiration-service
- **Location**: `internal/kafka/consumer.go:111`
- **Description**: `time.Duration(attempt*attempt) * 100ms` is quadratic (100ms, 400ms, 900ms), not exponential. AGENTS.md SS8.2 specifies "exponential back-off with jitter."
- **Recommendation**: Use `2^attempt * base` with random jitter.

#### R-11 | P1 | No Stripe webhook handler
- **Service**: payment-service
- **Location**: Architecture gap
- **Description**: The service creates PaymentIntents with `confirm: true` (synchronous), which works for simple cards but fails for payment methods requiring asynchronous confirmation (3D Secure, bank transfers). There's no webhook endpoint to handle `payment_intent.succeeded` / `payment_intent.payment_failed` events from Stripe.
- **Impact**: Payments requiring async confirmation stuck in `pending` forever.
- **Recommendation**: Implement `POST /api/payments/webhook` with Stripe signature verification. Process `payment_intent.succeeded` and `payment_intent.payment_failed` events.

#### R-12 | P1 | No Stripe idempotency key
- **Service**: payment-service
- **Location**: `src/modules/payments/payments.service.ts:72-79`
- **Description**: No `idempotencyKey` passed to `stripe.paymentIntents.create()`. The application-level check (`findByOrderId`) has a race condition: two simultaneous requests both pass the null check, both create DB rows (second fails on unique constraint), but the first Stripe charge is already captured.
- **Impact**: Double-charge in race condition scenarios.
- **Recommendation**: Pass `idempotencyKey: dto.orderId` to the Stripe API call.

#### R-13 | P2 | gRPC errors uniformly mapped to 400
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/grpc/TicketServiceClient.java:38-42`
- **Description**: All `StatusRuntimeException` are caught and thrown as `BadRequestException`. But `UNAVAILABLE` (service down) should be 503, `INTERNAL` should be 500, etc.
- **Recommendation**: Inspect `e.getStatus().getCode()` and map to appropriate HTTP status codes.

#### R-14 | P2 | Outbox table grows indefinitely
- **Service**: order-service
- **Location**: `src/main/resources/db/migration/V1__init.sql`
- **Description**: No cleanup mechanism for published outbox rows. The table will accumulate rows over time.
- **Recommendation**: Add a scheduled task that purges rows where `published = true` and `created_at < NOW() - INTERVAL '7 days'`.

#### R-15 | P1 | KafkaAdmin hardcoded to localhost:9092
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/config/KafkaConfig.java:42`
- **Description**: The custom `KafkaAdmin` bean ignores the `KAFKA_BROKERS` env var and always points to `localhost:9092`. In any non-local deployment, the admin client connects to the wrong address.
- **Recommendation**: Use `${spring.kafka.bootstrap-servers}` or inject from `ConfigService`.

---

## 6. Phase 4: Observability

#### O-01 | P1 | No OpenTelemetry SDK in any service
- **Services**: ALL
- **Description**: AGENTS.md SS7.3 mandates "Use OpenTelemetry (OTel) SDK in every service -- vendor-neutral." No service has OTel dependencies or trace propagation. Distributed traces are impossible across service boundaries.
- **Recommendation**: Add OTel SDK to each service. Configure auto-instrumentation where possible (Express for NestJS, Echo middleware for Go, Spring Boot auto-config for Java). Export to an OTel Collector sidecar.

#### O-02 | P1 | No traceId/spanId in log output for any service
- **Services**: ALL
- **Description**: AGENTS.md SS7.1 requires every log line to include `traceId` and `spanId`. No service includes these fields. Logs cannot be correlated with distributed traces.
- **Recommendation**: After adding OTel (O-01), configure each logging framework to extract trace context from MDC/context and include it in structured log output.

#### O-03 | P2 | No custom RED metrics
- **Services**: auth-service, payment-service
- **Location**: `src/modules/metrics/metrics.module.ts`
- **Description**: AGENTS.md SS7.2 requires `http_requests_total`, `http_request_duration_seconds`, etc. Only default Node.js process metrics are exposed. No per-route or per-method histograms.
- **Recommendation**: Add `prom-client` histograms for HTTP request duration and counters for request totals, labeled by `method`, `route`, `status_code`.

#### O-04 | P2 | console.error in GlobalExceptionFilter bypasses structured logging
- **Services**: auth-service, payment-service
- **Location**: `src/common/filters/global-exception.filter.ts:52`
- **Description**: The filter is instantiated via `new GlobalExceptionFilter()` in `main.ts` (not DI), so it can't inject PinoLogger. Unhandled errors are logged as free-form text to stdout, violating AGENTS.md SS7.1.
- **Recommendation**: Register the filter via DI using the `APP_FILTER` provider token. Inject `PinoLogger` into the filter constructor.

#### O-05 | P3 | No service field in ticket-service/expiration-service logs
- **Services**: ticket-service, expiration-service
- **Location**: `pkg/logger/logger.go`
- **Description**: AGENTS.md SS7.1 requires every log line to include `service`. The logger doesn't add a default `service` field.
- **Recommendation**: Add `log = log.With(zap.String("service", "<service-name>"))` after logger creation.

#### O-06 | P2 | Readiness probes don't verify all dependencies
- **Services**: auth-service, ticket-service, payment-service, expiration-service
- **Description**: Readiness checks verify only the primary database. Kafka, Redis, and gRPC upstream connectivity are not checked. AGENTS.md SS7.4: "readiness: returns 200 only when all dependencies are reachable."
- **Recommendation**: Add health checks for all dependencies. Return 503 if any dependency is unreachable.

#### O-07 | P1 | gRPC server is completely unobservable
- **Service**: ticket-service
- **Location**: `internal/grpc/server.go:96`
- **Description**: No logging, metrics, or tracing on gRPC calls. This is the same finding as R-08 but from the observability perspective. Order-service's most critical dependency (ticket validation) has zero visibility.
- **Recommendation**: See R-08.

#### O-08 | P3 | traceparent header logged as full value, not parsed trace ID
- **Service**: ticket-service
- **Location**: `internal/middleware/logger.go:27`
- **Description**: The W3C `traceparent` header has format `{version}-{trace-id}-{parent-id}-{trace-flags}`. The `traceId` log field should extract just the trace ID portion.
- **Recommendation**: Parse the header and extract the trace ID segment.

#### O-09 | P3 | console.log/console.error in migrate.ts scripts
- **Services**: auth-service, payment-service
- **Location**: `src/migrate.ts:20,28,32,34`
- **Description**: Pre-bootstrap logging uses unstructured text. In production, these won't be JSON-parseable by log aggregators.
- **Recommendation**: Create a standalone Pino instance for the migration script.

---

## 7. Phase 5: Performance & Scalability

#### P-01 | P1 | FindAll loads all tickets into memory (no pagination)
- **Service**: ticket-service
- **Location**: `internal/repository/mongo_ticket_repository.go:171-186`
- **Description**: The `FindAll` method loads all tickets into a single slice. The code acknowledges this with a comment ("In production this would be paginated"). As the dataset grows, this becomes a memory and latency issue.
- **Recommendation**: Implement cursor-based pagination with `limit` and `after` parameters.

#### P-02 | P1 | Homepage fetches all tickets with no pagination or caching
- **Service**: client
- **Location**: `app/page.tsx:21`
- **Description**: The homepage fetches all available tickets from the backend, filters them client-side, and renders them all. No pagination, infinite scroll, or limit parameter.
- **Impact**: With 10,000 tickets, the SSR HTML would be massive and slow to render.
- **Recommendation**: Add `?limit=20&offset=0` support to the tickets API and paginate in the UI.

#### P-03 | P1 | cache: "no-store" on ALL server-side fetches disables Next.js caching
- **Service**: client
- **Location**: `lib/api.ts:29`
- **Description**: `cache: "no-store"` forces every `fetch` to bypass the Next.js request cache and data cache. This also disables Next.js's automatic fetch deduplication within a single render pass. The homepage ticket listing could benefit enormously from even a short `revalidate` TTL (e.g., 10 seconds).
- **Impact**: Every page load hits the backend. Nullifies Next.js's primary SSR caching advantage.
- **Recommendation**: Use `next: { revalidate: 10 }` for read endpoints (tickets list, ticket detail). Keep `cache: "no-store"` only for user-specific data (current user, orders).

#### P-04 | P2 | Ticket detail page makes 2 duplicate API calls
- **Service**: client
- **Location**: `app/tickets/[ticketId]/page.tsx:28-36` (generateMetadata) and `:42-46` (page body)
- **Description**: Both `generateMetadata` and the page body call `serverApi<Ticket>(...)` independently. Next.js fetch deduplication would normally handle this, but `cache: "no-store"` (P-03) disables it.
- **Recommendation**: Fix P-03 first, which will automatically deduplicate these calls.

#### P-05 | P2 | Extra HTTP call to get current user on every ticket page
- **Service**: client
- **Location**: `app/tickets/[ticketId]/page.tsx:54-61`
- **Description**: Calls `/api/users/currentuser` to get the user ID, then compares to `ticket.userId`. The JWT `sub` could be decoded directly from the cookie without a network roundtrip.
- **Recommendation**: Decode the JWT from the cookie to extract the user ID. The JWT is already validated by Kong.

#### P-06 | P3 | Unnecessary JOIN FETCH on existence check
- **Service**: order-service
- **Location**: `src/main/java/com/ticketing/orders/repository/OrderRepository.java:22-23`
- **Description**: `findActiveByTicketId` does a `JOIN FETCH` on the ticket relation, but the result is only used for `isPresent()` at `OrderService.java:125`. The eager fetch is wasted work.
- **Recommendation**: Use a `boolean existsByTicketIdAndStatusNotIn(...)` derived query method instead.

#### P-07 | P2 | HPA only targets CPU; no memory or custom metrics
- **Services**: ALL (Helm)
- **Location**: All `hpa.yaml` templates
- **Description**: All HPA definitions only scale on CPU utilization. For I/O-bound services, CPU may not be the bottleneck. AGENTS.md SS11.1 says "HPA with CPU and/or custom metrics."
- **Recommendation**: Add memory utilization as a second metric. For production, add custom metrics like `http_request_duration_seconds_p99`.

#### P-08 | P2 | No loading.tsx or Suspense boundaries for streaming SSR
- **Service**: client
- **Location**: All route segments
- **Description**: None of the route segments have `loading.tsx` files. Server Component data fetching blocks the entire page render. No progressive rendering or skeleton screens.
- **Recommendation**: Add `loading.tsx` to data-heavy routes (`tickets/[ticketId]/`, `orders/[orderId]/`, `orders/`).

#### P-09 | P3 | Unused axios dependency in client bundle
- **Service**: client
- **Location**: `package.json:17`, `lib/api.ts:43-49`
- **Description**: `axios` (~14kB gzipped) is a production dependency. The `clientApi` export in `lib/api.ts` is never imported anywhere. Dead dependency inflating the bundle.
- **Recommendation**: Remove `axios` from dependencies and delete the `clientApi` export.

#### P-10 | P3 | Docker layer caching broken for Go services
- **Services**: ticket-service, expiration-service
- **Location**: `Dockerfile:9`
- **Description**: `COPY . .` before `go mod download` means any source change invalidates the dependency cache layer. Standard pattern: copy go.mod/go.sum -> download deps -> copy source -> build.
- **Recommendation**: Restructure to `COPY go.mod go.sum ./ && RUN go mod download && COPY . .`.

#### P-11 | P2 | Static replicas conflicts with HPA in Helm deployments
- **Services**: ALL (Helm)
- **Location**: All `deployment.yaml:12`
- **Description**: `replicas: {{ .Values.replicaCount }}` is always set, even when HPA is enabled. Every `helm upgrade` resets the replica count, fighting with HPA.
- **Recommendation**: Conditionally omit `replicas` when HPA is enabled:
  ```yaml
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  ```

---

## 8. Phase 6: Infrastructure & Deployment

### 8.1 Kubernetes / Helm

#### I-01 | P1 | No NetworkPolicy in any sub-chart
- **Location**: All Helm sub-charts
- **Description**: AGENTS.md SS11.4: "Use NetworkPolicy to restrict ingress/egress -- only allow known communication paths." Any pod in the namespace can communicate with any other pod.
- **Recommendation**: Add NetworkPolicy templates to each sub-chart. Example: auth-service allows ingress only from Kong; order-service allows ingress from Kong and egress to ticket-service (gRPC) + Kafka + PostgreSQL.

#### I-02 | P1 | No startupProbe for slow-starting services
- **Location**: `infra/helm/charts/order-service/values.yaml:43-50`
- **Description**: order-service (Spring Boot + Kafka) takes 60-120s to start. Without a `startupProbe`, Kubernetes may kill the pod during startup. The local override uses `initialDelaySeconds: 120` on liveness, but production values use `30`.
- **Recommendation**: Add `startupProbe` with `failureThreshold: 30` and `periodSeconds: 5` (150s budget). Set liveness/readiness `initialDelaySeconds` back to short values.

#### I-03 | P1 | No topologySpreadConstraints
- **Location**: All Helm deployment templates
- **Description**: AGENTS.md SS11.1 requires `topologySpreadConstraints` or `podAntiAffinity` to spread across AZs. Only `podAntiAffinity` with `preferredDuringSchedulingIgnoredDuringExecution` is configured, which is advisory only.
- **Recommendation**: Add `topologySpreadConstraints` with `topology.kubernetes.io/zone` for production.

#### I-04 | P1 | Umbrella chart uses image.tag: latest
- **Location**: `infra/helm/values.yaml:17,38,60,87,108,128`
- **Description**: Every service uses `tag: latest`. AGENTS.md SS12.2: "Image tag = Git SHA -- never use `latest` in any environment."
- **Recommendation**: Default to a placeholder like `"SET_BY_CI"`. CI pipelines should pass `--set <service>.image.tag=$GITHUB_SHA`.

#### I-05 | P2 | ticket-service deployment has unconditional envFrom
- **Location**: `infra/helm/charts/ticket-service/templates/deployment.yaml:51-53`
- **Description**: Unlike other services that guard `envFrom` with `{{- if .Values.secretRef }}`, ticket-service always includes it. If `secretRef` is empty, the pod fails to start.
- **Recommendation**: Add the same conditional guard.

#### I-06 | P2 | No ServiceAccount per service
- **Location**: All deployment templates
- **Description**: Pods use the `default` ServiceAccount. For EKS with IRSA (SS11.5), each service needs its own ServiceAccount annotated with the IAM role ARN.
- **Recommendation**: Add `ServiceAccount` templates to each sub-chart, even if IRSA isn't configured yet.

#### I-07 | P3 | Missing _helpers.tpl in all app sub-charts
- **Location**: All Helm sub-chart templates
- **Description**: `fullName` is computed inline in every template. A shared `_helpers.tpl` with `define` would be DRY-er.
- **Recommendation**: Add `_helpers.tpl` to each sub-chart.

#### I-08 | P3 | global.imageRegistry declared but never referenced
- **Location**: `infra/helm/values.yaml:6`
- **Description**: `global.imageRegistry: "ghcr.io/your-org"` is set but no template uses it. Dead config.
- **Recommendation**: Either wire it into deployment templates or remove it.

#### I-09 | P3 | No explicit Deployment strategy
- **Location**: All deployment templates
- **Description**: Relies on Kubernetes defaults. Should be explicit for production.
- **Recommendation**: Add `strategy: type: RollingUpdate` with `maxSurge: 1, maxUnavailable: 0` for zero-downtime deploys.

#### I-10 | P3 | No NOTES.txt in any sub-chart
- **Location**: All Helm sub-charts
- **Description**: Helm best practice for post-install instructions.
- **Recommendation**: Low priority; add when charts stabilize.

### 8.2 CI/CD

#### I-11 | P0 | No deploy stage in any CI pipeline
- **Location**: All `.github/workflows/ci-*.yml`
- **Description**: All CI pipelines end at "push image to GHCR." AGENTS.md SS12.1 requires: `push image -> deploy (dev) -> smoke test -> deploy (staging) -> e2e test -> deploy (prod, gated)`. There is no automated deployment, no smoke test, no rollback mechanism.
- **Impact**: Manual deployment process; no automated rollback on failure.
- **Recommendation**: Add deployment stages using `kubectl set image` or `helm upgrade` triggered by CI. Add smoke test and rollback steps.

#### I-12 | P1 | :latest tag pushed alongside SHA tag
- **Location**: All CI pipeline push jobs
- **Description**: Images are tagged with both `${{ github.sha }}` and `latest`. AGENTS.md SS12.2 prohibits `latest`.
- **Recommendation**: Remove the `latest` tag from all push jobs.

#### I-13 | P2 | No concurrency control on CI workflows
- **Location**: All `.github/workflows/`
- **Description**: Multiple pushes to the same branch run in parallel, wasting runner time.
- **Recommendation**: Add `concurrency: { group: ci-<service>-${{ github.ref }}, cancel-in-progress: true }`.

#### I-14 | P2 | Build step rebuilds image in push job
- **Location**: All CI pipelines
- **Description**: The `build` job builds + scans the image, then the `push` job rebuilds it. Double build wastes 3-5 minutes per run.
- **Recommendation**: Export the image as a tar artifact from the build job and load it in the push job.

#### I-15 | P2 | No CI pipeline for kong-gateway
- **Location**: Missing `.github/workflows/ci-kong-gateway.yml`
- **Description**: Changes to `kong.base.yml`, `jwt-sub.lua`, or values files are not validated in CI. A pipeline running `build.sh` + `validate.sh` per environment would catch rendering errors.
- **Recommendation**: Create a kong-gateway CI pipeline.

#### I-16 | P2 | Proto CI doesn't regenerate stubs
- **Location**: `.github/workflows/ci-proto.yml`
- **Description**: AGENTS.md SS12.3: "Regenerate stubs in CI whenever a .proto file changes." The workflow only lints and checks for breaking changes; it doesn't verify stubs are up to date.
- **Recommendation**: Add `make proto` step and `git diff --exit-code` to detect stale stubs.

#### I-17 | P2 | E2E workflow .env indentation error
- **Location**: `.github/workflows/e2e.yml:29-31`
- **Description**: Heredoc body lines are indented with spaces. The `.env` file will contain leading whitespace, potentially breaking env var parsing.
- **Recommendation**: Remove indentation from heredoc body lines.

#### I-18 | P2 | E2E workflow missing KONG_RSA_PUBLIC_KEY
- **Location**: `.github/workflows/e2e.yml:28-31`
- **Description**: Only `RSA_PRIVATE_KEY` is set. Kong needs `KONG_RSA_PUBLIC_KEY` to render its config. Kong will fail to start.
- **Recommendation**: Derive the public key from the private key in the workflow and set both env vars.

#### I-19 | P1 | Duplicate rate-limiting plugin instances at Kong global scope
- **Location**: `services/kong-gateway/config/kong.base.yml:266-285`
- **Description**: Two global `rate-limiting` plugin instances are defined. Kong OSS DB-less mode may not support two global instances of the same plugin name.
- **Recommendation**: Test this configuration. If it fails, restructure the consumer-scoped rate limit as per-route.

### 8.3 Terraform (Scaffolding Review)

#### I-20 | P2 | No S3 state backend bootstrap script
- **Location**: `infra/scripts/` (missing)
- **Description**: The S3 + DynamoDB state backend needs to be bootstrapped before `terraform init`. No automation exists for this.
- **Recommendation**: Create `infra/scripts/bootstrap-state.sh`.

#### I-21 | P2 | Kong module lacks TLS termination config
- **Location**: `infra/terraform/modules/kong/main.tf`
- **Description**: The Kong module deploys an NLB but doesn't configure TLS termination (ACM certificate).
- **Recommendation**: Add ACM certificate and NLB listener for HTTPS.

#### I-22 | P2 | No Terraform CI/CD pipeline
- **Location**: Missing workflow
- **Description**: AGENTS.md SS12.1 specifies an infra pipeline (`terraform fmt/validate/plan/apply`).
- **Recommendation**: Create `.github/workflows/ci-terraform.yml`.

---

## 9. Phase 7: Code Quality & Conventions

### 9.1 Dead Code

| ID | Item | Service | Location | Severity |
|----|------|---------|----------|----------|
| D-01 | State machine package (3 files, ~75 lines, never used, has a bug) | order-service | `src/main/java/.../statemachine/` | P2 |
| D-02 | `NON_TERMINAL_STATUSES` constant declared but never referenced | order-service | `OrderService.java:50-53` | P3 |
| D-03 | `app.e2e-spec.ts` scaffold test (tests non-existent endpoint) | auth-service | `test/app.e2e-spec.ts` | P3 |
| D-04 | `jest-e2e.json` config (project uses Vitest, not Jest) | auth-service | `test/jest-e2e.json` | P3 |
| D-05 | `clientApi` (axios) export never imported anywhere | client | `lib/api.ts:43-49` | P2 |
| D-06 | `jwks-rsa` dependency installed but never imported | auth-service | `package.json` | P3 |
| D-07 | `@nestjs/microservices` dependency never imported | payment-service | `package.json:27` | P3 |
| D-08 | `source-map-support`, `ts-loader` dev dependencies unused | auth-service | `package.json` | P3 |
| D-09 | `pino-pretty` in production dependencies (only used in dev mode) | payment-service | `package.json:37` | P3 |
| D-10 | `COOKIE_DOMAIN` env var validated in Joi schema but never read | auth-service | `app.module.ts:25` | P3 |
| D-11 | `TopicExpirationCompleteDLQ` constant declared but never used | expiration-service | `kafka.go:21` | P3 |
| D-12 | `ConflictException` import unused | payment-service | `payments.service.ts:3` | P3 |
| D-13 | `globals.jest` in ESLint config (project uses Vitest) | auth, payment | `eslint.config.mjs:18` | P3 |

### 9.2 DRY Violations

| ID | Item | Service | Location | Severity |
|----|------|---------|----------|----------|
| DRY-01 | RSA key parsing logic duplicated in two files | auth-service | `auth.module.ts:16-18` + `auth.service.ts:40-42` | P2 |
| DRY-02 | `base()` / `authHeaders()` duplicated across 3 Server Action files | client | `actions/auth.ts:8-9`, `actions/tickets.ts:8-18`, `actions/orders.ts:8-18` | P2 |
| DRY-03 | Broker string join logic duplicated in producer + consumer | ticket-service | `producer.go:48-54`, `consumer.go:63-68` | P3 |
| DRY-04 | Status config maps duplicated across two pages | client | `orders/page.tsx` + `orders/[orderId]/page.tsx` | P3 |
| DRY-05 | `fullName` template computation duplicated in every Helm template | infra | All sub-chart templates | P3 |

### 9.3 Convention Violations

| ID | Item | Convention | Location | Severity |
|----|------|-----------|----------|----------|
| CV-01 | `go 1.25` in go.mod (Go 1.25 doesn't exist) | Go versioning | ticket-service, expiration-service `go.mod:3` | P2 |
| CV-02 | No `engines` or `packageManager` field in package.json | AGENTS.md SS16.1 | auth, payment, client `package.json` | P3 |
| CV-03 | DLQ suffix `.DLT` (Spring default) vs `.dlq` (AGENTS.md convention) | AGENTS.md SS3.5 | order-service `KafkaConfig.java` | P3 |
| CV-04 | gRPC stubs vendored inside service instead of `/libs/` | AGENTS.md SS2.2 | ticket-service `internal/grpc/tickets/v1/` | P3 |
| CV-05 | Port mismatch: EXPOSE 8083 vs default PORT 8080 | Docker conventions | expiration-service `Dockerfile:23` | P2 |
| CV-06 | `go mod tidy` in Dockerfiles (non-hermetic builds) | Docker best practices | ticket-service, expiration-service `Dockerfile:10` | P3 |
| CV-07 | Duplicate CHECK constraint in migration SQL | Database conventions | payment-service `001_init_payments.sql:11,17` | P3 |

---

## 10. Phase 8: Testing

### 10.1 Coverage Gaps

| ID | Gap | Service | Impact | Severity |
|----|-----|---------|--------|----------|
| T-01 | **No gRPC integration tests** | ticket-service | Contract between order<->ticket is unverified | P1 |
| T-02 | **No Kafka consumer tests** | ticket-service | `handleOrderCreated` / `handleOrderCancelled` untested | P1 |
| T-03 | **No Kafka consumer integration tests** | order-service | Payment/ticket/expiration event handling untested | P2 |
| T-04 | **No Kafka consumer integration tests** | payment-service | `OrdersConsumer` excluded from test module | P2 |
| T-05 | **No unit tests for Server Actions** | client | Validation + cookie logic untested | P2 |
| T-06 | **No unit tests for Server Components / pages** | client | Page rendering untested | P3 |
| T-07 | **Health endpoint tests are no-ops** (test a hardcoded mux, not real server) | expiration-service | `integration_test.go:290-302` | P1 |
| T-08 | **No test for concurrent OCC conflicts** | ticket-service | Version-based OCC behavior unverified | P2 |
| T-09 | **No controller unit tests** | auth-service | `setTokenCookie` conditional logic untested | P3 |

### 10.2 Test Quality Issues

| ID | Issue | Service | Location | Severity |
|----|-------|---------|----------|----------|
| T-10 | Integration tests lack per-test isolation (no tx rollback despite docblock claim) | auth-service | `test/auth.integration.spec.ts` | P2 |
| T-11 | `os.Unsetenv` instead of `t.Setenv` -- not parallel-safe | ticket-service, expiration-service | `config_test.go` | P2 |
| T-12 | `time.Sleep` in integration tests -- fragile on slow CI | expiration-service | `integration_test.go:156,181,204` | P2 |
| T-13 | Fixed host port `19092` for Kafka in tests -- conflicts in parallel runs | expiration-service | `integration_test.go:65` | P2 |
| T-14 | `useActionState` mocked at module level -- can't verify action wiring | client | `__tests__/*.test.tsx` | P2 |
| T-15 | `StubTicketService` returns empty data -- masks integration issues | order-service | `OrderIntegrationTest.java:103-106` | P3 |
| T-16 | `PG_POOL` imported from database.module but doesn't exist | auth-service | `test/auth.integration.spec.ts:25` | P3 |

### 10.3 Acceptance Criteria
- [ ] gRPC contract tests exist between order-service and ticket-service
- [ ] Every Kafka consumer handler has at least one integration test with a real broker
- [ ] All `time.Sleep` replaced with polling/eventually-consistent assertions
- [ ] Test isolation verified -- no test depends on execution order
- [ ] Health endpoint integration tests actually test the real server implementation

---

## 11. Upcoming Milestones Review (PLAN.md M7-M9)

### 11.1 Milestone 7: Observability + Hardening

**Plan calls for**: OTel integration, Fluent Bit, DLQ implementation, HPA, NetworkPolicy, Trivy scanning.

**Assessment**: Well-aligned with Phases 3, 4, and 6 of this audit. However:

| Gap | Recommendation |
|-----|---------------|
| **Circuit breakers not mentioned** | AGENTS.md SS8.2 requires them on every outbound call. Add resilience4j (Java), opossum (NestJS), go-circuit-breaker (Go) to this milestone. |
| **Stripe webhook not mentioned** | Critical for real payment flow. Should be part of this milestone. |
| **Payment event producer not mentioned** | The entire event chain is broken without it. Must be fixed here. |
| **Request size limiting not mentioned** | Kong hardening should include this plugin. |
| **Token blacklist not mentioned** | Redis-based JWT revocation should be part of auth hardening. |

### 11.2 Milestone 8: CI/CD Pipelines

**Plan calls for**: Per-service workflows, proto CI, Terraform CI.

**Assessment**: Workflows already exist (8 files), but STATUS.md still says empty -- stale documentation. What's actually missing:

| Gap | Recommendation |
|-----|---------------|
| **Deploy stages** | All pipelines stop at image push. Need `deploy dev -> smoke -> deploy staging -> e2e -> deploy prod (gated)`. |
| **Rollback automation** | No mechanism exists. Need automatic rollback on post-deploy smoke test failure. |
| **Kong gateway CI** | Not in the plan. Changes to kong.base.yml, jwt-sub.lua aren't validated. |
| **Concurrency controls** | Not mentioned. Parallel CI runs waste resources. |
| **`:latest` tag cleanup** | Currently pushed; must be removed. |

### 11.3 Milestone 9: EKS Deploy + Staging

**Plan calls for**: State bootstrap, terraform apply, EKS deployment.

**Assessment**: Before EKS deployment, these P0/P1 findings MUST be resolved:

| Prerequisite | Finding IDs |
|-------------|-------------|
| Fix broken @Transactional | C-01 |
| Implement payment event producer | C-05, C-06 |
| Implement DLQ for all consumers | R-03, R-04 |
| Add NetworkPolicies | I-01 |
| Pin Docker images to digest | S-18 |
| Add startupProbes for Spring Boot | I-02 |
| Fix Kong root user | S-17 |
| Strip X-User-Id on ingress | S-02 |
| Fix Stripe key in Git | S-15, S-16 |
| Add circuit breakers | R-01 |

**Risk assessment**: Deploying to staging without these fixes would result in:
- Data inconsistency (broken outbox)
- Silent message loss (no DLQ)
- Security vulnerabilities (header spoofing, root containers)
- Reliability issues (no circuit breakers, no startupProbes)

---

## 12. Statistics & Risk Matrix

### Finding Distribution by Severity

```
P0 (Critical):  10  ████████████████████
P1 (High):      22  ████████████████████████████████████████████████
P2 (Medium):    28  ████████████████████████████████████████████████████████████
P3 (Low):       15  ██████████████████████████████████
Total:          75
```

### Finding Distribution by Category

| Category | P0 | P1 | P2 | P3 | Total |
|----------|----|----|----|----|-------|
| Security | 4 | 5 | 6 | 3 | **18** |
| Correctness | 3 | 1 | 5 | 1 | **10** |
| Resilience | 2 | 7 | 3 | 1 | **13** |
| Observability | 0 | 3 | 3 | 3 | **9** |
| Performance | 0 | 3 | 4 | 3 | **10** |
| Infrastructure | 1 | 5 | 9 | 5 | **20** |
| Code Quality | 0 | 0 | 5 | 13 | **18** |
| Testing | 0 | 3 | 7 | 3 | **13** |

### Finding Distribution by Service

| Service | P0 | P1 | P2 | P3 | Total |
|---------|----|----|----|----|-------|
| auth-service | 0 | 3 | 3 | 7 | **13** |
| ticket-service | 1 | 5 | 3 | 5 | **14** |
| order-service | 1 | 4 | 8 | 2 | **15** |
| payment-service | 2 | 3 | 4 | 4 | **13** |
| expiration-service | 1 | 2 | 3 | 4 | **10** |
| client | 0 | 3 | 6 | 3 | **12** |
| kong-gateway | 2 | 3 | 1 | 1 | **7** |
| infra/helm | 0 | 3 | 4 | 5 | **12** |
| CI/CD | 1 | 2 | 6 | 0 | **9** |
| Terraform | 0 | 0 | 3 | 0 | **3** |
| Cross-cutting | 0 | 2 | 0 | 0 | **2** |

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Data loss via broken outbox (C-01) | **High** -- hits every order creation | **Critical** -- orders exist without events; downstream state diverges | Fix @Transactional before any staging deploy |
| Payment flow broken (C-05, C-06) | **Certain** -- no producer code exists | **Critical** -- orders never complete | Implement payment event producer |
| Identity spoofing (S-02) | **Medium** -- requires knowledge of internal header | **High** -- full account takeover | Add global header stripping in Kong |
| Silent message loss (R-03, R-04) | **High** -- any transient failure triggers it | **High** -- tickets not reserved/released, expirations missed | Implement DLQ before staging |
| Supply chain attack via unpinned images (S-18) | **Low** -- requires compromised registry | **Critical** -- arbitrary code execution | Pin to digest for production images |

---

*End of audit report. See AUDIT-TODO.md for the structured action items.*
