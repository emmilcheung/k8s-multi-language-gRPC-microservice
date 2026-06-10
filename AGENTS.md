# Engineering Documentation Index

> Lightweight TOC for on-demand loading. The agent contract and hard stops live in [`CLAUDE.md`](CLAUDE.md). Human onboarding (ports, stack, local dev) lives in [`README.md`](README.md). Load individual `docs/XX-*.md` files only when their topic is relevant to the task at hand.

## Standards

| # | File | Purpose |
|---|---|---|
| 1 | [`docs/01-guiding-principles.md`](docs/01-guiding-principles.md) | 7 core principles |
| 2 | [`docs/02-repository-structure.md`](docs/02-repository-structure.md) | Monorepo layout, service naming, language choice |
| 3 | [`docs/03-api-design.md`](docs/03-api-design.md) | External REST (Kong) + internal gRPC, versioning |
| 4 | [`docs/04-asynchronous-messaging.md`](docs/04-asynchronous-messaging.md) | Kafka, CloudEvents, idempotency, DLQ |
| 5 | [`docs/05-data-conventions.md`](docs/05-data-conventions.md) | Postgres, Mongo, Redis: schema, indexing, TTL |
| 6 | [`docs/06-security.md`](docs/06-security.md) | Auth, secrets, input validation, TLS, supply chain |
| 7 | [`docs/07-caching-rate-limiting.md`](docs/07-caching-rate-limiting.md) | Cache strategies, invalidation, Kong rate limiting |
| 8 | [`docs/08-observability.md`](docs/08-observability.md) | Structured logs, RED metrics, OTel, `/healthz` |
| 9 | [`docs/09-error-handling.md`](docs/09-error-handling.md) | Classification, retries, circuit breakers, timeouts |
| 10 | [`docs/10-docker-containers.md`](docs/10-docker-containers.md) | Multi-stage, non-root, pinned digests, Trivy |
| 11 | [`docs/11-kubernetes-deployment.md`](docs/11-kubernetes-deployment.md) | Helm, manifests, NetworkPolicy, EKS specifics |
| 12 | [`docs/12-ci-cd.md`](docs/12-ci-cd.md) | Pipeline, SHA tags, proto compat, prod gate |
| 13 | [`docs/13-testing.md`](docs/13-testing.md) | Pyramid, unit/integration/contract/E2E |
| 14 | [`docs/14-git-collaboration.md`](docs/14-git-collaboration.md) | Trunk-based, Conventional Commits, PR rules |

## Process

| File | Purpose |
|---|---|
| [`docs/15-agent-hard-stops.md`](docs/15-agent-hard-stops.md) | Full detail on the 10 operations requiring user confirmation |
| [`docs/17-agent-workflow.md`](docs/17-agent-workflow.md) | Post-harness validation loop (lint + E2E) |
| [`docs/18-slos-and-load-testing.md`](docs/18-slos-and-load-testing.md) | Read-path SLOs, error budget, k6 load-test methodology |
| [`docs/SUBAGENT_ORCHESTRATION.md`](docs/SUBAGENT_ORCHESTRATION.md) | Project-specific manager/worker patterns, dependency graph |

## Log

| File | Purpose |
|---|---|
| [`docs/16-session-progress-log.md`](docs/16-session-progress-log.md) | Chronological session record, PRs, state transitions |
| [`docs/ticketing/status.md`](docs/ticketing/status.md) | Ticketing workstream status |
| [`docs/ticketing/workstreams.md`](docs/ticketing/workstreams.md) | Ticketing workstream specs |

## Agent skills (invokable)

- `/orchestrate` — manager-worker mode for multi-workstream features
- `lint-check` — CI-aligned static validation
- `end-to-end-check` — E2E coverage guard after implementation loops
- `frontend-design` — distinctive production-grade UI
- Built-in superpowers skills — brainstorming, TDD, debugging, planning

## Contributing to docs

1. Determine the right category above.
2. Edit the relevant `docs/XX-*.md` (don't inline into `AGENTS.md` or `CLAUDE.md`).
3. If adding a new category, add a TOC row here.
4. For significant decisions, add a session entry to `docs/16-session-progress-log.md`.
5. Commit with `docs(<category>): <description>`.

---

*Last Updated: 2026-04-17*
