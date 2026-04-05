# venue-service — Agent Guidelines

> **Source of truth:** [`/AGENTS.md`](../../AGENTS.md) at the monorepo root.
> These notes extend and specialise the root guidelines for this service.
> When anything here conflicts with the root, the **root wins**.

---

## Service Identity

| Field | Value |
|---|---|
| **Role** | Venue and seated inventory — venue templates, seating plans, seat holds, seated reservation ledger |
| **Language** | Go 1.25+ |
| **Framework** | Echo v4 (HTTP), gRPC server (serves `order-service`) |
| **Module** | `github.com/acme/venue-service` |
| **Test tooling** | `testify` + `testcontainers-go` |
| **Database** | PostgreSQL (dedicated `venue_db` — NOT shared with other services) |
| **Cache** | Redis (shared cluster, cluster-safe keys with hash tags) |
| **Messaging** | Kafka consumer (`orders.order.cancelled`, `orders.order.completed`) |
| **gRPC** | Server — exposes `VenueService` (proto: `/proto/venue/v1/`) |
| **HTTP port** | 3003 |
| **gRPC port** | 50052 |

---

## Quick Commands

```bash
# Build
go build ./...

# Run all tests (unit + integration)
go test ./...

# Run only unit tests (no Testcontainers)
go test -short ./...

# Vet (must pass before push)
go vet ./...

# Run service locally (with env vars)
go run ./cmd/server
```

---

## Project Layout

```
cmd/
  server/
    main.go             ← entry-point; validates config, wires deps, starts Echo + gRPC
internal/
  config/               ← env var parsing + validation (fail loudly at startup)
  grpc/                 ← gRPC server implementation (VenueService)
  handler/              ← Echo HTTP handlers (health, seat-hold, availability, SSE)
  health/               ← DBChecker, RedisChecker, KafkaChecker
  kafka/                ← OrderConsumer + Producer (CloudEvents envelope)
  middleware/           ← Echo middleware (request logger with OTel trace injection)
  migrations/           ← golang-migrate SQL files + Run() bootstrap
  repository/           ← domain types + repository interfaces + sentinel errors
  service/              ← VenueService business logic (Kafka event handlers)
  tracing/              ← OpenTelemetry SDK bootstrap
pkg/
  logger/               ← zap JSON logger constructor
test/                   ← integration tests (Testcontainers — PostgreSQL + Kafka)
```

---

## Key Design Decisions

See [`docs/plan/venue-seating-plan-design.md`](../../docs/plan/venue-seating-plan-design.md) for the full design.

- **Seat inventory owned exclusively by venue-service.** No other service queries the venue DB.
- **All seated purchase operations are keyed by `reservationId`** — not `orderId` or raw seat IDs.
- **`ticket_id` on `seating_plans` is nullable** during draft creation; required before activation.
- **Redis keys are cluster-safe**: all keys use hash tag `{planId}` to avoid cross-slot scripts.
- **PostgreSQL reservation rows are the durable source of truth.** Redis is the hot path only.
- **Kafka consumer is idempotent**: `ReleaseReservation` and `FinalizeReservation` are no-ops on already-terminal reservations.

---

## gRPC — Venue gRPC Server

- Proto source of truth: [`/proto/venue/v1/`](../../proto/venue/v1/).
- Generated stubs in [`/libs/grpc-stubs/go/venue/v1/`](../../libs/grpc-stubs/go/venue/v1/) — do NOT hand-edit.
- CP-07: all RPCs return `UNIMPLEMENTED` except `GetSeatingPlan` (basic scaffold).
- Full implementation arrives in CP-09 (holds), CP-10 (reservation lifecycle), CP-11 (auto-assign).

---

## Kafka — Consumer Rules

- Consumed topics: `orders.order.cancelled`, `orders.order.completed`.
- Only events carrying a non-empty `reservationId` are processed; GA-only orders are skipped.
- Manual commit: only commit after successful processing.
- Consumer group ID: `venue-service`.

---

## Database Rules

- **Dedicated PostgreSQL instance** (`postgres-venue`). No cross-service DB access.
- Migrations in `internal/migrations/` — numbered `001_` to `NNN_`, append-only after merge.
- `golang-migrate` runs automatically at startup via `migrations.Run()`.
- UUID primary keys everywhere.
- Optimistic concurrency on `seating_plans` via `version` column.
- Named columns in all queries — `SELECT *` is forbidden.

---

## Redis Key Conventions (Cluster-Safe)

All keys are scoped to a plan via hash tag:

```
venue:{planId}:seats                     → HASH   seatId → stateByte
venue:{planId}:hold:{seatId}            → STRING hold metadata (TTL = holdTtlSec)
venue:{planId}:user-holds:{userId}      → SET    seatIds held by user (TTL)
venue:{planId}:changes                  → PUBSUB channel for SSE
```

This ensures all keys for a plan land on the same Redis Cluster slot.

---

## Security Notes

- **Never accept `userId` from the request body** for hold/reserve endpoints — derive from Kong-injected `X-User-Id` header.
- Attendee names are PII — do not log them.
- Sanitise seat labels and organizer-defined names before logging.
- Rate-limit hold endpoints aggressively at Kong and service level.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL DSN |
| `KAFKA_BROKERS` | yes | — | Comma-separated broker list |
| `REDIS_URL` | no | — | Redis URL (optional) |
| `PORT` | no | 3003 | HTTP server port |
| `GRPC_PORT` | no | 50052 | gRPC server port |
| `LOG_LEVEL` | no | info | Zap log level |
| `APP_ENV` | no | development | Environment tag |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | OTel collector; no-op if unset |

---

## Hard Stops (inherit from root)

See [§15 Agent Hard Stops](../../docs/15-agent-hard-stops.md). Key items for this service:

- Do **not** run DB migrations against any non-local environment without explicit confirmation.
- Do **not** modify Kafka topic configuration without explicit confirmation.
- Do **not** hand-edit files in `libs/grpc-stubs/go/` — regenerate with `make proto`.
- Do **not** add a new Go module dependency (`go get`) without noting it and explaining why.
- Do **not** log `userId`, attendee names, or any PII.
