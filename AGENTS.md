# Engineering Guidelines — Modern Microservices Platform

> **Loaded by the agent at the start of every session.**
> These are the authoritative engineering standards for this platform.
> Follow every section strictly. User overrides in the active session take precedence over this file.

---

## 0. Guiding Principles

1. **Services are independent units of deployment.** A change in one service must never require a coordinated deploy of another.
2. **Fail loudly at startup, silently never.** Every service validates its config at boot and refuses to start if anything is missing.
3. **Own your data.** Each service owns exactly one datastore. No service queries another service's database directly, ever.
4. **Design for failure.** Every network call can fail. Apply timeouts, retries with exponential back-off, and circuit breakers everywhere.
5. **Minimal blast radius.** Scope each change to the smallest possible surface. Do not refactor, rename, or reformat code outside the task boundary.
6. **Security is not optional.** Treat every piece of user input as hostile. Validate and sanitise at every service boundary.
7. **Observable by default.** Every service emits structured logs, metrics, and traces from day one — not as an afterthought.

---

## 1. Repository & Project Structure

### 1.1 Monorepo Layout (recommended)
```
/
├── services/
│   ├── <service-name>/          # one directory per service
│   │   ├── src/                 # application source
│   │   ├── proto/               # .proto files owned by this service
│   │   ├── Dockerfile
│   │   ├── <lang-manifest>      # package.json / go.mod / pyproject.toml / pom.xml
│   │   └── README.md            # service-level docs (purpose, ports, env vars)
├── infra/
│   ├── k8s/                     # Kubernetes base manifests
│   ├── helm/                    # Helm charts per service
│   ├── terraform/               # EKS cluster, VPC, RDS, MSK, ElastiCache, Kong
│   └── scripts/                 # cluster bootstrap, secret seeding
├── proto/                       # shared .proto definitions (contracts between services)
├── libs/                        # shared libraries (generated gRPC stubs, common schemas)
├── .github/workflows/           # CI/CD pipelines
└── AGENTS.md                    # this file
```

### 1.2 Service Naming
- Kebab-case: `order-service`, `payment-service`, `notification-service`.
- Kubernetes objects follow the same name: deployment `order-service`, service `order-service`, namespace `<env>`.
- gRPC package names: `<company>.<domain>.<version>` e.g. `acme.orders.v1`.

### 1.3 Language Choice
- Choose the best language for the job; mixing languages across services is intentional.
- **TypeScript/Node.js** — event-driven, I/O-heavy services, BFF/API gateways.
- **Go** — high-throughput, latency-sensitive services (gRPC servers, stream processors).
- **Python** — ML inference, data pipelines, scripting.
- **Java/Kotlin** — enterprise integrations, batch workloads.
- Whatever language is chosen, apply the same structural rules (validation, error handling, observability, testing) described in this document.

---

## 2. API Design

### 2.1 External APIs (REST via Kong API Gateway)
- All external traffic enters through Kong — never expose a service pod directly.
- Use **REST + JSON** for public/client-facing APIs.
- Versioning in the path prefix: `/v1/orders`, `/v2/tickets`. Never break an existing version.
- Use standard HTTP semantics:
  - `GET` — safe, idempotent reads.
  - `POST` — non-idempotent creation.
  - `PUT` — full replacement (idempotent).
  - `PATCH` — partial update (idempotent where possible).
  - `DELETE` — idempotent removal.
- HTTP status codes must be accurate:
  - `200 OK`, `201 Created`, `204 No Content`
  - `400 Bad Request` (validation failure), `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`
  - `422 Unprocessable Entity` (semantic validation failure)
  - `429 Too Many Requests` (rate limited)
  - `500 Internal Server Error` (unhandled; never return stack traces)
- Error response body (always consistent):
  ```json
  {
    "error": {
      "code": "VALIDATION_FAILED",
      "message": "Human-readable description",
      "details": [{ "field": "email", "issue": "must be a valid email" }]
    }
  }
  ```

### 2.2 Internal APIs (gRPC)
- **All synchronous service-to-service communication uses gRPC** — never REST between internal services.
- `.proto` files are the source of truth for the contract. Proto definitions live in `/proto/<domain>/<service>/v<N>/<file>.proto`.
- Use **proto3** syntax only.
- Version the package (`v1`, `v2`) — never delete or rename a field; only add new fields or new RPCs.
- Always define `google.protobuf.Timestamp` for time fields — never `string`.
- Wire IDs as `string` (UUIDs), not `int64`.
- Generated stubs live in `/libs/grpc-stubs/<lang>/` — regenerate with `make proto`.
- Set explicit deadlines on every client call (default: 5 s for reads, 10 s for writes).
- Apply gRPC status codes correctly:
  - `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED`, `INTERNAL`, `UNAVAILABLE`.

### 2.3 API Gateway (Kong)
- All Kong configuration is declarative (deck / KongIngress CRD) — never click-ops in the admin UI.
- Plugins applied globally (at gateway level): authentication, rate limiting, request logging, correlation ID injection.
- Plugins applied per-route: additional auth scopes, custom rate limits, request/response transformation.
- Never route internal gRPC traffic through Kong — gRPC stays on the internal cluster network.

---

## 3. Asynchronous Messaging (Kafka)

### 3.1 When to Use Kafka vs gRPC
| Use Kafka | Use gRPC |
|---|---|
| Event fan-out to multiple consumers | One caller needs an immediate response |
| Cross-domain eventual consistency | Strong consistency within a request scope |
| Audit log / event sourcing | Real-time bi-directional streaming between two services |
| Decoupling producer from consumer lifecycle | Internal lookups and aggregations |

### 3.2 Topic Naming Convention
```
<domain>.<entity>.<event-verb>
# Examples:
orders.order.created
orders.order.cancelled
payments.payment.captured
inventory.stock.depleted
```

### 3.3 Event Schema (Avro or JSON Schema — pick one per domain, be consistent)
Every event envelope must contain:
```json
{
  "specversion": "1.0",
  "type": "orders.order.created",
  "source": "order-service",
  "id": "<uuid-v4>",
  "time": "<ISO-8601>",
  "datacontenttype": "application/json",
  "data": { /* domain payload */ }
}
```
Follow **CloudEvents v1.0** spec for the envelope. Validate against the schema registry before producing.

### 3.4 Producer Rules
- Events are **immutable facts** — never mutate or delete a published event.
- Use **transactional outbox pattern** when producing from a database transaction: write to an `outbox` table in the same DB transaction as the business update; a relay process publishes to Kafka. Never produce to Kafka directly inside a DB transaction.
- Set `acks=all` and `enable.idempotence=true` on every producer.
- Partition key = primary entity ID (e.g. `orderId`) to preserve per-entity ordering.

### 3.5 Consumer Rules
- Consumers must be **idempotent** — the same message may be delivered more than once.
- Use consumer group IDs named after the service: `order-service`, `notification-service`.
- Commit offsets **after** successful processing, not before.
- On processing failure: retry with back-off (exponential, max 3 attempts), then route to a **Dead Letter Topic** (`<original-topic>.dlq`). Never silently discard a message.
- Do not mix business logic with offset management — separate the Kafka polling loop from the handler function.

---

## 4. Data & Database Conventions

### 4.1 Database-per-Service
- Each service gets its own isolated datastore — no cross-service DB access.
- Choose the right database for the access pattern:

| Store | Use when |
|---|---|
| **PostgreSQL** | Relational data, ACID transactions, complex joins, financial records |
| **MongoDB** | Document-oriented data, flexible schema, high write throughput, nested structures |
| **Redis** | Cache, session store, rate-limit counters, distributed locks, pub/sub |
| **Elasticsearch** | Full-text search, log aggregation |

### 4.2 PostgreSQL Conventions
- Use migrations (Flyway / Liquibase / TypeORM migrations / golang-migrate) — never alter schema manually.
- Migration files are append-only and immutable once merged to main.
- Always name constraints explicitly: `fk_orders_user_id`, `uq_users_email`, `ck_price_positive`.
- Use `UUID` as primary keys (v4), not auto-increment integers.
- `created_at` and `updated_at` timestamps on every table, maintained by DB triggers or ORM hooks.
- Use row-level locking (`SELECT ... FOR UPDATE`) for optimistic or pessimistic concurrency — never rely on application-level locking across network calls.
- Never use `SELECT *` — always name columns explicitly.
- Index every foreign key and every column used in `WHERE`, `ORDER BY`, or `JOIN` clauses.
- Sensitive columns (PII, secrets): encrypt at rest at the application layer; do not rely solely on disk encryption.

### 4.3 MongoDB Conventions
- Define and enforce a JSON Schema validator on every collection.
- Always include `createdAt`, `updatedAt` fields (mongoose `timestamps` option or equivalent).
- Use UUIDs (`string`) as `_id` — do not rely on ObjectId across services (not portable).
- Index fields used in query filters and sorts; profile with `explain()` before deploying to production.
- Use sessions and multi-document transactions only when atomicity is truly required — prefer document embedding to avoid the need.
- Apply optimistic concurrency control (OCC) with a `__v` / `version` field for documents updated concurrently.

### 4.4 Redis Conventions
- Cache keys: `<service>:<entity>:<id>` e.g. `order-service:order:uuid-123`.
- Always set a TTL — never persist a key without expiry unless it is an explicit, intentional data store.
- Use Redis Cluster or ElastiCache cluster mode in production — do not use single-node Redis for production data.
- Distributed locks: use Redlock algorithm with a minimum of 3 nodes.
- Never store sensitive data (passwords, raw tokens) in Redis.

---

## 5. Authentication & Authorisation

### 5.1 Authentication (at the Gateway)
- Kong handles AuthN for all external requests using the **JWT** or **OAuth 2.0 / OIDC** plugin.
- Services receive a verified identity via a forwarded header (e.g. `X-User-Id`, `X-User-Roles`) injected by Kong after token validation — services must not re-validate the token.
- Internal gRPC calls propagate identity via **gRPC metadata** headers (same header names as above).
- JWTs: short-lived access tokens (15 min), long-lived refresh tokens stored server-side (Redis) and rotatable. RS256 signing — public keys distributed to Kong via JWKS endpoint.

### 5.2 Authorisation (in the Service)
- Authorisation is service-level responsibility — Kong does not enforce business-level permissions.
- Apply the principle of least privilege: check that the acting user owns or has permission to act on the requested resource.
- Role/permission checks must happen before any DB write or expensive computation.

### 5.3 Secrets Management
- **All secrets come from environment variables injected at runtime** — never hardcoded, never in source control, never in Docker images.
- In EKS: use **AWS Secrets Manager** or **Parameter Store** with the Secrets Store CSI driver, or **External Secrets Operator** — never Kubernetes `Secret` YAML committed to Git.
- Rotate secrets without downtime by supporting dual-key validation during rotation windows.
- Never log a secret, token, password, or API key. Sanitise log output explicitly if there is any chance of exposure.

---

## 6. Caching & Rate Limiting

### 6.1 Caching Strategy
- **Cache at the gateway (Kong)**: response caching for public, read-heavy endpoints.
- **Cache at the service**: application-level cache in Redis for expensive DB reads or aggregations.
- Cache invalidation: prefer **event-driven invalidation** (listen to domain events that mutate the entity) over time-based expiry for accuracy-critical data.
- Never cache: authentication responses, user-specific write confirmations, financial totals, any data with security implications.
- Cache-aside pattern (lazy loading) is the default. Only use write-through/write-behind when consistency requirements demand it.

### 6.2 Rate Limiting
- Global rate limiting: configured in Kong using the `rate-limiting` or `rate-limiting-advanced` plugin backed by Redis (cluster mode).
- Limits applied at: IP level (anonymous), consumer/API-key level (authenticated), and per-route.
- Respond with `429 Too Many Requests` and include headers:
  ```
  X-RateLimit-Limit: 100
  X-RateLimit-Remaining: 0
  X-RateLimit-Reset: <unix-timestamp>
  Retry-After: 60
  ```
- Internal services are exempt from public rate limits but have separate circuit-breaker thresholds.

---

## 7. Observability

### 7.1 Structured Logging
- **Always log as JSON** — never free-form text.
- Every log line must include: `timestamp` (ISO-8601), `level`, `service`, `traceId`, `spanId`, `message`, and any relevant context fields.
- Log levels: `DEBUG` (dev only), `INFO` (normal operation), `WARN` (degraded but not broken), `ERROR` (requires attention), `FATAL` (service cannot continue).
- Never log PII (names, emails, phone numbers, addresses) or secrets. Hash or mask if context is needed.
- Ship logs to a centralised store (e.g. CloudWatch Logs, Datadog, ELK) — do not rely on `kubectl logs` in production.

### 7.2 Metrics
- Expose a `/metrics` endpoint in Prometheus format (or use the CloudWatch agent for EKS).
- Instrument every service with the **RED method**: Request rate, Error rate, Duration (latency histogram).
- Expose at minimum: `http_requests_total`, `http_request_duration_seconds`, `grpc_server_handled_total`, `kafka_consumer_lag`.
- Use labels consistently: `service`, `method`, `status_code`, `route`.

### 7.3 Distributed Tracing
- Use **OpenTelemetry (OTel)** SDK in every service — vendor-neutral.
- Propagate trace context via W3C `traceparent` header on HTTP and gRPC metadata on gRPC calls.
- Auto-instrument frameworks where possible (Express, Gin, Spring Boot, Django).
- Export traces to an OTel Collector sidecar, which forwards to your tracing backend (Jaeger, Tempo, AWS X-Ray).
- Every Kafka consumer/producer must propagate trace context through the message headers.

### 7.4 Health Checks
Every service must expose:
- `GET /healthz/live` — liveness: returns `200` if the process is alive (no external dependency checks).
- `GET /healthz/ready` — readiness: returns `200` only when all dependencies (DB, Kafka, gRPC upstreams) are reachable. Returns `503` otherwise.
- Configure Kubernetes `livenessProbe` and `readinessProbe` against these endpoints.

---

## 8. Error Handling

### 8.1 Principles
- Errors are classified: **operational** (expected, recoverable — e.g. validation, not found) vs **programmer** (unexpected — e.g. null dereference, type error). Log and alert differently.
- Operational errors: return a meaningful structured error response to the caller. Do not log at `ERROR`.
- Programmer errors: log at `ERROR` with full context (stack trace, request ID, user ID), return a generic `500` to the caller. Alert on these.
- Never swallow errors silently (`catch {}` or `_ = err`).

### 8.2 Retry & Resilience
- Apply **exponential back-off with jitter** for retries on transient failures (network timeouts, `503`, Kafka producer errors).
- Use a **circuit breaker** (e.g. resilience4j, go-circuit-breaker, opossum) on every gRPC client and outbound HTTP call.
  - Closed → Open when error rate exceeds threshold (e.g. 50% over 10 s window).
  - Open → Half-Open after a cooldown period.
  - Half-Open → Closed on success, back to Open on failure.
- Define and test **fallback behaviour** for every circuit breaker — return cached data, a default response, or a graceful degradation message.

### 8.3 Timeouts
Set explicit timeouts at every layer:

| Layer | Typical timeout |
|---|---|
| Kong upstream | 60 s (adjust per route) |
| gRPC client read | 5 s |
| gRPC client write | 10 s |
| DB query | 30 s |
| Kafka producer send | 10 s |
| Redis command | 1 s |
| External HTTP call | 10 s |

Never use default (infinite) timeouts in any production code.

---

## 9. Security

### 9.1 Input Validation
- Validate every field of every external request at the service boundary — type, format, length, range, allowed values.
- Use a schema-based validation library (Zod, Joi, Pydantic, Jakarta Bean Validation, go-playground/validator) — not manual `if` chains.
- Reject unknown fields — do not pass them through or store them.
- Sanitise user-supplied strings before using them in DB queries, log lines, or templated responses.

### 9.2 Injection Prevention
- **SQL**: use parameterised queries / prepared statements exclusively. ORM query builders are acceptable but must never concatenate raw user input.
- **NoSQL**: use the ORM/driver query builder API. Never construct a query object from raw user input.
- **Command injection**: never pass user input to `exec`, `spawn`, or shell commands.
- **SSRF**: validate and whitelist URLs before making outbound HTTP requests. Never allow user-supplied URLs to internal network ranges.
- **Log injection**: sanitise user input before including in log messages (strip newlines at minimum).

### 9.3 Transport Security
- All traffic between Kong and external clients: TLS 1.2+ (enforce TLS 1.3 where possible).
- All traffic inside the cluster: mTLS via a service mesh (Istio or Linkerd) — services do not implement mTLS themselves.
- Never disable certificate verification (`InsecureSkipVerify`, `rejectUnauthorized: false`) except in local dev, and even then prefer self-signed certs over disabling verification.

### 9.4 Supply Chain
- Pin all base Docker images to a specific digest (not just a tag).
- Run `npm audit` / `go vuln` / `pip-audit` / `trivy` in CI — fail the build on high/critical CVEs.
- Use a private container registry — never pull untrusted images in production.
- Keep dependencies up to date with automated PRs (Dependabot or Renovate).

---

## 10. Containerisation (Docker)

### 10.1 Dockerfile Standards
```dockerfile
# Stage 1: build
FROM <lang>:<pinned-version>-alpine AS builder
WORKDIR /app
COPY <manifest-files> .
RUN <install-deps>          # only prod deps in final stage
COPY src/ ./src/
RUN <build-command>

# Stage 2: runtime
FROM <lang>:<pinned-version>-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/dist ./dist
USER app                    # never run as root
EXPOSE <port>
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:<port>/healthz/live || exit 1
CMD ["<entrypoint>"]
```

- **Always use multi-stage builds** — keep build tools out of the runtime image.
- **Never run as root** — create and use a dedicated non-root user.
- **Pin image versions to digest** in production: `FROM node:22.2.0-alpine@sha256:...`.
- **No secrets in images** — pass via env vars at runtime, not baked in.
- `.dockerignore` must exclude: `node_modules/`, `*.test.*`, `.env`, `.git`, CI config, docs.

### 10.2 Image Size
- Prefer Alpine or distroless base images.
- Remove build artefacts and package manager caches in the same `RUN` layer they are created.
- Scan images with `trivy` or `grype` in CI.

---

## 11. Kubernetes & EKS Deployment

### 11.1 Manifest Conventions
- Use **Helm charts** per service — no raw manifest files checked in (except cluster bootstrap).
- Chart values are environment-specific: `values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`.
- Every Deployment must define:
  - `resources.requests` and `resources.limits` (CPU and memory) — no unbounded pods.
  - `livenessProbe` and `readinessProbe`.
  - `terminationGracePeriodSeconds` (≥ 30 s for graceful shutdown).
  - `podDisruptionBudget` (at least 1 pod always available in prod).
  - `topologySpreadConstraints` or `podAntiAffinity` to spread across AZs.
- Replicas: minimum 2 in staging, minimum 3 in production.
- Use `HorizontalPodAutoscaler` (HPA) with CPU and/or custom metrics.

### 11.2 Namespace Strategy
```
<service>-dev
<service>-staging
<service>-prod
infra          # Kong, observability stack, cert-manager
```

### 11.3 Configuration & Secrets
- ConfigMaps for non-sensitive config (feature flags, tuning params).
- Secrets via External Secrets Operator pulling from AWS Secrets Manager — never commit secret values.
- Environment variable naming: `SCREAMING_SNAKE_CASE`.

### 11.4 Networking
- Services communicate via Kubernetes `Service` DNS: `<service-name>.<namespace>.svc.cluster.local`.
- Use `NetworkPolicy` to restrict ingress/egress — only allow known communication paths.
- Kong Ingress Controller manages external ingress — no `NodePort` in production.

### 11.5 EKS-Specific
- Use managed node groups with Karpenter for auto-scaling.
- IAM Roles for Service Accounts (IRSA) — never use long-lived AWS credentials in pods.
- Enable EKS control plane logging (API, audit, authenticator, controller manager, scheduler).
- Use AWS Load Balancer Controller for `Service` type `LoadBalancer`.
- Store Terraform state in S3 + DynamoDB lock — never local state in CI.

---

## 12. CI/CD

### 12.1 Pipeline Stages (every service)
```
lint → test (unit) → test (integration) → build image → scan image → push image → deploy (dev) → smoke test → deploy (staging) → e2e test → deploy (prod, gated)
```

### 12.2 Rules
- **No merge to main without passing CI** — branch protection enforced.
- **Image tag = Git SHA** — never use `latest` in any environment.
- Integration tests run against real dependencies spun up in Docker Compose (local) or ephemeral namespaces (CI).
- Production deploys require a manual approval gate.
- Rollback is automated: if the post-deploy smoke test fails, the pipeline rolls back to the previous image tag automatically.

### 12.3 Proto Changes
- Regenerate stubs (`make proto`) in CI whenever a `.proto` file changes.
- Run a compatibility check (buf breaking) — fail CI if a breaking change is introduced without a version bump.

---

## 13. Testing Standards

### 13.1 Test Pyramid
- **Unit tests** (70%): pure functions, business logic, domain models. No I/O. Fast.
- **Integration tests** (20%): test one service with its real database and message broker running in Docker. No mocks except other services.
- **Contract tests** (5%): validate that gRPC/REST contracts between services match what producers emit and consumers expect (Pact or buf-based).
- **E2E tests** (5%): full system tests via Kong against a staging environment. Cover only critical user journeys.

### 13.2 Rules
- Every public function/method must have a unit test.
- Integration tests must clean up their own data — use transactions rolled back after each test, or wipe test-namespaced data.
- Do not mock databases or message brokers in integration tests — use real instances (Docker Compose, TestContainers).
- Tests must be deterministic — no `sleep()`, no clock-dependent assertions without injecting a fake clock.
- CI test runs must complete in under 10 minutes — split into parallelised jobs if they exceed this.
- Test coverage is a guide, not a goal — prioritise testing critical paths and edge cases over chasing a coverage number.

### 13.3 Test Naming
- Unit: `<function> should <expected behaviour> when <condition>`
- Integration: `<endpoint or flow> returns <expected outcome> given <setup>`

---

## 14. Git & Collaboration

### 14.1 Branching Strategy
- **Trunk-based development**: short-lived feature branches off `main`, merged via PR within 1–2 days.
- Branch names: `feat/<short-description>`, `fix/<short-description>`, `chore/<short-description>`.
- No long-lived branches (no `develop`, no `release` branches) — use feature flags for incomplete work.

### 14.2 Commit Messages (Conventional Commits)
```
<type>(<scope>): <short description>

[optional body — why, not what]

[optional footer: BREAKING CHANGE, closes #issue]
```
Types: `feat`, `fix`, `perf`, `refactor`, `test`, `chore`, `ci`, `docs`, `build`.
Scope: service or infra area e.g. `feat(order-service)`, `chore(infra/terraform)`.

### 14.3 Pull Request Rules
- PRs must reference an issue or ticket.
- Description must include: what changed, why, how to test, and any migration steps.
- Require at least 1 peer review before merge.
- Squash merge to keep `main` history linear and clean.
- No PR merges if CI is failing or if there are unresolved review threads.

### 14.4 What Never Goes in Git
- Secrets, API keys, passwords, tokens.
- `.env` files (use `.env.example` with placeholder values).
- Compiled artefacts (`dist/`, `build/`, `target/`, `__pycache__/`).
- Container images, large binary assets.
- Terraform state files or `.terraform/` directories.

---

## 15. Agent Hard Stops

The agent must **not** perform the following without explicit user confirmation in the active session:

1. `kubectl delete` / `helm uninstall` / `terraform destroy` against any non-local environment.
2. `git push --force`, `git reset --hard`, `git rebase` on a shared branch.
3. Run any database migration against a staging or production DB.
4. Drop, truncate, or wipe a database or collection outside of test helpers.
5. Publish to a package registry or container registry.
6. Rotate, delete, or disable any secret, certificate, or IAM role.
7. Modify Kafka topic configuration (retention, partition count, replication factor) on a live cluster.
8. Include a secret, token, or password in any file, log, or terminal output.
9. Install a new dependency without noting it and stating why it is needed.
10. Open a port, configure a public endpoint, or change a security group / NetworkPolicy without user review.

---

*Maintained in the repo root. Update this file when new services, patterns, or architectural decisions are introduced.*

---

## 16. Implementation Conventions (Agent Workflow Notes)

> Added during active implementation. Overrides general guidelines where more specific.

### 16.1 Language & Framework Choices (confirmed)

| Service | Language | Framework | Package Manager | Test runner |
|---|---|---|---|---|
| auth-service | TypeScript / Node.js 24 LTS | NestJS 10 | **pnpm** | **Vitest** (not Jest — user confirmed) |
| ticket-service | Go 1.23+ | Echo v4 | — | testify + testcontainers-go |
| order-service | Java 21 | Spring Boot 4 | Maven | JUnit 5 + Testcontainers |
| payment-service | TypeScript / Node.js 24 LTS | NestJS 10 | **pnpm** | **Vitest** (not Jest) |
| expiration-service | Go 1.23+ | Echo v4 (health/metrics only) | — | testify + testcontainers-go |
| client | TypeScript | Next.js 15 App Router | **pnpm** | **Vitest** |

> **Node.js version & package manager:** All Node.js applications use **Node.js 24 LTS** (not 22 LTS) and **pnpm** (not npm). pnpm is faster, uses less disk space, and has better monorepo support.

### 16.2 Security Choices (confirmed)

- **Password hashing:** `argon2` (argon2id variant) — current best practice
- **JWT:** `@nestjs/jwt` wrapping `jsonwebtoken` — RS256, 15-min access tokens
- **JWKS:** served at `GET /.well-known/jwks.json` by auth-service

### 16.3 Local Development Approach

- **Docker Compose** for all dev dependencies: PostgreSQL ×3, MongoDB, Redis, Kafka (KRaft mode), Confluent Schema Registry
- Kafka uses **KRaft mode** (no ZooKeeper) in docker-compose to keep resource use minimal
- All compose services use `mem_limit` to cap memory on low-spec machines
- **No cloud resources** are created during application development phase
- Local K8s (minikube) deferred until after all services are implemented and passing tests

### 16.4 Docker Compose File Location

- Root: `docker-compose.yml` — all shared dev infrastructure
- Each service has its own `docker-compose.override.yml` for service-specific local overrides (optional)
- `.env.example` at repo root documents all required env vars with safe placeholder values

### 16.5 NestJS Conventions (auth-service, payment-service)

- Use NestJS CLI project structure: `src/modules/<domain>/` per feature module
- `ConfigModule` with `validationSchema` (Joi) at app root — **fail loudly at startup** on missing env vars
- `nestjs-pino` for JSON structured logging — replace default NestJS logger globally
- Never use `console.log` — always inject `Logger` from `@nestjs/common` or use `PinoLogger`
- DTOs use `class-validator` decorators; `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true` globally
- `@nestjs/config` for env var access — never `process.env` directly in business logic
- Controllers are thin — all business logic in services
- Repository pattern: one repository class per DB entity; services depend on repositories, not raw DB clients

### 16.6 Go Conventions (ticket-service, expiration-service)

- Project layout follows standard Go module structure: `cmd/`, `internal/`, `pkg/`
- `internal/handler/` for Echo route handlers (thin — delegate to service layer)
- `internal/service/` for business logic
- `internal/repository/` for DB access
- Use `zap` for structured logging — never `fmt.Printf` or `log.Println`
- Config via `envconfig` or manual `os.Getenv` with startup validation — crash on missing required vars
- Always use `context.Context` as first argument on all functions that do I/O
- Errors wrap with `fmt.Errorf("...: %w", err)` — never discard errors

### 16.7 Dependency Installation Logging

- **Always suppress verbose install output** in commands to preserve LLM context window:
  - `pnpm add <pkg> --silent` (Node.js / pnpm)
  - `go get -q <pkg>` (Go)
  - `npm install --silent` (legacy npm, if needed)
  - Redirect stderr: `2>/dev/null` for terminal-only progress output
- **Always state why** a new dependency is being added **before** installing it — describe its purpose in 1–2 sentences
- Example: "Installing `drizzle-orm` — a lightweight TypeScript ORM for type-safe database queries with auto-generated migrations via drizzle-kit"

### 16.8 Testing Conventions

- Unit tests live alongside source: `<file>_test.go` (Go), `<file>.spec.ts` (TS)
- Integration tests in `test/` subdirectory of the service
- Testcontainers used for all integration tests — no mocking of DB or Kafka
- Tests must be deterministic — no `sleep()`, inject fake clocks where needed
- Each test cleans up its own data (transactions rolled back or test-namespaced keys)

### 16.9 Environment Variable Naming

- All env vars: `SCREAMING_SNAKE_CASE`
- Each service has a `.env.example` file — committed; `.env` — gitignored
- Sensitive vars (passwords, keys) always have placeholder values in `.env.example`, never real values
