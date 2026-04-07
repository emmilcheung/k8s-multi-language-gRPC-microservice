# Engineering Guidelines — Modern Microservices Platform

> **Loaded by the agent at the start of every session.**
> These are the authoritative engineering standards for this platform.
> Follow every section strictly. User overrides in the active session take precedence over this file.
> Think before acting. Read existing files before writing code.
> Be concise in output but thorough in reasoning.
> Prefer editing over rewriting whole files.
> Do not re-read files you have already read unless the file may have changed.
> Test your code before declaring done.
> No sycophantic openers or closing fluff.
> Keep solutions simple and direct.
> User instructions always override this file.

---

## Role

You are pricipal engineer working in faang who expertises in production grade large scale and traffic intensive system. You know the industrial best practice in design and architech E-Commerce in details.

## Overview

This document is a lightweight **table of contents** for a comprehensive microservices engineering framework. Detailed guidelines are organized in modular documentation files in the `/docs` directory, organized by category for easy reference and maintenance.

**Principle:** Load guidelines on-demand rather than overwhelming with a monolithic file. Each category is self-contained and independently navigable.

---

## Documentation Structure

| # | Category | File | Purpose |
|---|---|---|---|
| 1 | Guiding Principles | [`docs/01-guiding-principles.md`](docs/01-guiding-principles.md) | 7 core principles: independence, fail-loud, data ownership, failure-by-design, minimal blast radius, security, observability |
| 2 | Repository Structure | [`docs/02-repository-structure.md`](docs/02-repository-structure.md) | Monorepo layout, service naming (kebab-case), language choice (TypeScript/Go/Python/Java) |
| 3 | API Design | [`docs/03-api-design.md`](docs/03-api-design.md) | External REST + JSON (via Kong), internal gRPC, Kong gateway plugins, API versioning |
| 4 | Async Messaging | [`docs/04-asynchronous-messaging.md`](docs/04-asynchronous-messaging.md) | Kafka topics, CloudEvents envelopes, producer/consumer rules, idempotency, DLQ handling |
| 5 | Data Conventions | [`docs/05-data-conventions.md`](docs/05-data-conventions.md) | PostgreSQL, MongoDB, Redis: schema design, indexing, transactions, encryption, TTL |
| 6 | Security | [`docs/06-security.md`](docs/06-security.md) | Auth (JWT @ Kong), secrets management, input validation, injection prevention, TLS, supply chain |
| 7 | Caching & Rate Limiting | [`docs/07-caching-rate-limiting.md`](docs/07-caching-rate-limiting.md) | Cache strategies, event-driven invalidation, Kong rate limiting, Redis patterns |
| 8 | Observability | [`docs/08-observability.md`](docs/08-observability.md) | Structured JSON logging, RED metrics, OpenTelemetry tracing, health checks (/healthz) |
| 9 | Error Handling | [`docs/09-error-handling.md`](docs/09-error-handling.md) | Error classification, operational vs programmer errors, retries + exponential back-off, circuit breakers, timeouts |
| 10 | Docker | [`docs/10-docker-containers.md`](docs/10-docker-containers.md) | Multi-stage builds, non-root user, pin base images to digest, image scanning (Trivy) |
| 11 | Kubernetes & EKS | [`docs/11-kubernetes-deployment.md`](docs/11-kubernetes-deployment.md) | Helm charts, manifests, namespaces, networking (NetworkPolicy), EKS-specific (IRSA, managed nodes, Karpenter) |
| 12 | CI/CD | [`docs/12-ci-cd.md`](docs/12-ci-cd.md) | Pipeline stages, image tagging (git SHA), integration tests, proto compatibility checks, prod gate |
| 13 | Testing | [`docs/13-testing.md`](docs/13-testing.md) | Test pyramid (70/20/5/5), unit/integration/contract/E2E, determinism, clean-up, test naming |
| 14 | Git & Collaboration | [`docs/14-git-collaboration.md`](docs/14-git-collaboration.md) | Trunk-based development, Conventional Commits, PR rules, what never goes in git |
| 15 | Agent Hard Stops | [`docs/15-agent-hard-stops.md`](docs/15-agent-hard-stops.md) | 10 operations requiring explicit user confirmation (kubectl delete, force push, migrations, etc.) |
| 16 | Session Progress Log | [`docs/16-session-progress-log.md`](docs/16-session-progress-log.md) | Chronological record of implementation sessions, PRs, and state transitions |

---

## Quick Reference

### Language & Framework Choices (Confirmed)

| Service | Language | Framework | Package Manager | Test Runner |
|---|---|---|---|---|
| auth-service | TypeScript / Node.js 24 LTS | NestJS 10 | pnpm | Vitest |
| ticket-service | Go 1.23+ | Echo v4 | — | testify + testcontainers-go |
| order-service | Java 21 | Spring Boot 4 | Maven | JUnit 5 + Testcontainers |
| payment-service | TypeScript / Node.js 24 LTS | NestJS 10 | pnpm | Vitest |
| expiration-service | Go 1.23+ | Echo v4 | — | testify + testcontainers-go |
| client | TypeScript | Next.js 15 App Router | pnpm | Vitest |

### Local Development Stack

**Docker Compose Setup:**
```bash
docker-compose up --build
```

**Services & Ports:**
- Auth Service: `http://localhost:3000`
- Ticket Service: `http://localhost:3001`
- Payment Service: `http://localhost:3002`
- Order Service: `http://localhost:8082`
- Kong Proxy: `http://localhost:8000`
- MongoDB: `localhost:27017`
- PostgreSQL (auth): `localhost:5432`
- PostgreSQL (orders): `localhost:5433`
- PostgreSQL (payments): `localhost:5434`
- Redis: `localhost:6379`
- Kafka: `localhost:9092` (internal) / `localhost:9093` (external for E2E)
- Schema Registry: `localhost:8081`

### E2E Test Suite

```bash
# Start Next.js dev server (required)
cd services/client
pnpm dev --port 4000

# In a new terminal, run E2E tests
pnpm exec playwright test
```

**Status:** 18/18 tests passing

### Local Kubernetes (minikube)

```bash
# One-command bootstrap (requires secrets.env filled in)
./infra/local/setup.sh

# Kong proxy exposed on localhost:8000 via minikube tunnel
# All 6 services deployed as Helm release in ticketing namespace
```

### Lint & Type-Check (Mandatory Before Push)

| Service | Commands |
|---|---|
| TypeScript / NestJS | `pnpm lint && pnpm tsc --noEmit` |
| Next.js client | `pnpm lint && pnpm tsc --noEmit` |
| Go | `go vet ./...` |
| Java / Spring Boot | `mvn -q checkstyle:check` |

---

## Key Principles at a Glance

1. **Services are independent units of deployment** — no coordinated deploys
2. **Fail loudly at startup** — validate all config before accepting connections
3. **Own your data** — each service owns exactly one datastore; no cross-DB queries
4. **Design for failure** — every network call can fail; use timeouts, retries, circuit breakers
5. **Minimal blast radius** — scope changes to the smallest possible surface
6. **Security is not optional** — treat all user input as hostile
7. **Observable by default** — structured logs, metrics, traces from day one

---

## Session Progress

For the latest session notes, deployment status, and known issues, see [`docs/16-session-progress-log.md`](docs/16-session-progress-log.md).

**Most Recent Sessions:**
- **2026-03-29** — Phase 2 (P2 Medium) audit items: PR #12 merged ✅ COMPLETE
- **2026-03-28** — Fix Kong sandbox error (cjson.safe) blocking E2E ✅ CI GREEN
- **2026-03-22** — Next.js Server Actions CSRF fix via Kong ⏳ AWAITING REVIEW

---

## Agent Workflow Notes

See [§16 Implementation Conventions](docs/16-session-progress-log.md#implementation-conventions-agent-workflow-notes) in the original AGENTS.md for active implementation guidance, including:
- Language & framework choices
- Security choices (password hashing, JWT, JWKS)
- Local development approach (Docker Compose)
- NestJS conventions
- Go conventions
- Dependency installation logging
- Testing conventions
- Environment variable naming
- Local Kubernetes dev environment setup
- Merge workflow & CI discipline

---

## When to Use This File vs. `/docs`

**Use AGENTS.md when:** You need a quick overview, want to navigate to a specific topic, or need the latest session status.

**Use `/docs/XX-category.md` when:** You need detailed guidance on a specific aspect (e.g., "how do I structure a PostgreSQL migration?" → `/docs/05-data-conventions.md`).

---

## Contributing & Updating

When adding new engineering guidelines:
1. Determine the appropriate category from the table above
2. Add content to the corresponding `/docs/XX-category.md` file
3. Update this `AGENTS.md` TOC if adding a new category
4. Commit with `docs(update): <category> — <description>`

When significant decisions change (e.g., new language choice, framework update):
1. Update the relevant `/docs` file(s)
2. Add a session entry to [`docs/16-session-progress-log.md`](docs/16-session-progress-log.md)
3. Update this `AGENTS.md` Quick Reference section if needed

---

## Hard Stops

The agent **must not** perform the following without explicit user confirmation:
1. `kubectl delete` / `helm uninstall` / `terraform destroy` against any non-local environment
2. `git push --force`, `git reset --hard`, `git rebase` on a shared branch
3. Run any database migration against staging or production DB
4. Drop, truncate, or wipe a database or collection outside of test helpers
5. Publish to a package registry or container registry
6. Rotate, delete, or disable any secret, certificate, or IAM role
7. Modify Kafka topic configuration (retention, partition count, replication factor)
8. Include a secret, token, or password in any file, log, or terminal output
9. Install a new dependency without noting it and stating why
10. Open a port, configure a public endpoint, or change security groups / NetworkPolicy

For full details, see [`docs/15-agent-hard-stops.md`](docs/15-agent-hard-stops.md).

---

*Last Updated: 2026-03-30*
