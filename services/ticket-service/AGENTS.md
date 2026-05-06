# ticket-service — Agent Guidelines

> Service-specific notes; defers to root [`/AGENTS.md`](../../AGENTS.md) on conflict.

---

## Service Identity

| Field | Value |
|---|---|
| **Role** | Ticket catalogue — create, update, and serve ticket inventory; emits events on ticket changes |
| **Language** | Go 1.25+ |
| **Framework** | Echo v4 (HTTP), gRPC server (serves `order-service`) |
| **Module** | `github.com/acme/ticket-service` |
| **Test tooling** | `testify` + `testcontainers-go` |
| **Database** | PostgreSQL |
| **Messaging** | Kafka producer (`confluent-kafka-go/v2`) |
| **gRPC** | Server — exposes `TicketService` (proto: `/proto/tickets/v1/`) |
| **HTTP port** | 3001 |

---

## Quick Commands

```bash
# Build
go build ./...

# Run all tests (unit + integration)
go test ./...

# Run only unit tests (skip integration tags)
go test -short ./...

# Vet (must pass before push)
go vet ./...

# Regenerate gRPC stubs from proto (run from repo root)
make proto

# Run service locally (with env vars)
go run ./cmd/server
```

---

## Project Layout

```
cmd/
  server/
    main.go             ← entry-point; validates config, wires deps, starts Echo + gRPC listeners
internal/
  config/               ← env var parsing + validation (fail loudly at startup)
  handler/              ← Echo HTTP handlers (thin — delegate to service layer)
  service/              ← business logic
  repository/           ← PostgreSQL data access (pgx or database/sql)
  kafka/                ← Kafka producer setup + message publishing
  grpc/                 ← gRPC server implementation (generated interface)
  cache/                ← Redis cache helpers
  middleware/           ← Echo middleware (logging, tracing, metrics, recovery)
  health/               ← /healthz/live + /healthz/ready handlers
  tracing/              ← OpenTelemetry SDK bootstrap
pkg/                    ← exportable helpers shared with tests
test/                   ← integration tests (Testcontainers)
```

---

## Go Conventions

- **`internal/` is the enforcement boundary.** Nothing outside this module can import `internal/` packages. Keep cross-cutting concerns (config, tracing, middleware) in `internal/`.
- **Error handling — never swallow.** Every error must be checked and either returned or logged. `_ = err` is forbidden.
- **Wrap errors with context:** use `fmt.Errorf("doSomething: %w", err)` so stack traces are meaningful.
- **Return errors, do not panic** in library code. The only legitimate use of `panic` is a programming error at startup (e.g. missing required config).
- **Use `context.Context` everywhere.** Pass `ctx` as the first argument down the entire call chain. Honour cancellations.
- **Explicit `struct` tags on all domain types:** `json:"field_name"` and `db:"column_name"` where relevant.
- **No global state.** Inject dependencies via constructor functions, not `init()` or package-level vars.
- **Table-driven tests.** Group related cases in `[]struct{ name, input, expected }` slices; iterate with `t.Run`.

---

## gRPC — Ticket gRPC Server

- Proto source of truth: [`/proto/tickets/v1/`](../../proto/tickets/v1/).
- Generated stubs land in [`/libs/grpc-stubs/go/`](../../libs/grpc-stubs/go/) — regenerate with `make proto` at repo root; **do not hand-edit generated files**.
- Implement the generated `TicketServiceServer` interface in `internal/grpc/`.
- Set explicit deadlines on incoming RPCs: reject calls where the incoming deadline has already expired.
- Use gRPC status codes consistently: `NOT_FOUND`, `INVALID_ARGUMENT`, `ALREADY_EXISTS`, `INTERNAL` — never map to an HTTP status directly.
- **Never break an existing proto field.** Only add fields or new RPCs. Follow the wire compatibility rules in [§03 API Design](../../docs/03-api-design.md).

---

## Kafka — Producer Rules

- Topic produced to: `tickets.ticket.created`, `tickets.ticket.updated`.
- Partition key = `ticketId` (preserves per-ticket ordering).
- Use **transactional outbox pattern**: write the outbox record inside the same DB transaction as the business update; a relay goroutine reads and publishes.
- Producer config: `acks=all`, `enable.idempotence=true`.
- Event envelope must follow CloudEvents v1.0 (see [§04](../../docs/04-asynchronous-messaging.md)).
- On producer failure: log at `ERROR` with the failing message payload (no PII), then surface a `500` to the caller — **never silently discard**.

---

## Database Rules

- **Parameterised queries only.** Use `pgx` named parameters or `?` placeholders — never string-interpolate user data into SQL.
- **Migrations** are managed by `golang-migrate` (or equivalent). Migration files are append-only and immutable after merge to `main`.
- **UUID primary keys** (`google/uuid` package). No serial integers in the public API.
- **Optimistic concurrency control (OCC):** ticket rows have a `version` column. Increment on every update; reject writes where the incoming version doesn't match (return `409 Conflict`).
- **`SELECT *` is forbidden.** Name every column explicitly.
- Index FK columns and any column used in `WHERE` / `ORDER BY`.

---

## Security

- This service follows the consuming-service auth pattern — see [`/docs/06-security.md`](../../docs/06-security.md#consuming-service-pattern). Read `X-User-Id` / `X-User-Roles` from the Echo context via middleware.
- **Ownership check before any write:** confirm the caller's `X-User-Id` matches the ticket's `userId` before allowing updates.
- **Validate all input** using `go-playground/validator` or equivalent. Reject unknown fields.
- **No user-controlled data in log fields** without sanitisation. Strip newlines to prevent log injection.
- **SSRF prevention:** if this service fetches any external URL (e.g. image URL validation), maintain an explicit allowlist of trusted domains.

---

## Observability

- Structured JSON logging via `go.uber.org/zap`. Every log entry must carry `traceId`, `spanId`, `service=ticket-service`.
- `tracing.go` bootstraps the OTel SDK — call it before starting Echo and gRPC listeners.
- Echo middleware (`otelecho`) propagates W3C `traceparent` headers automatically.
- Prometheus metrics via `echo-contrib`; expose at `GET /metrics`.
- RED metrics: `http_requests_total`, `http_request_duration_seconds`, `grpc_server_handled_total`.
- Health: `GET /healthz/live` (200 always) and `GET /healthz/ready` (checks DB + Kafka + Redis).

---

## Testing

- **Unit tests** (`*_test.go` in `internal/`): mock DB and Kafka with interfaces. Use `testify/mock` or simple interface stubs.
- **Integration tests** (`test/` directory): spin up PostgreSQL, Redis, Kafka and (optionally) a mock gRPC server via `testcontainers-go`. Clean up all created records in `t.Cleanup`.
- Test name format: `TestDoSomething_ShouldBehave_WhenCondition`.
- Use `-short` flag to skip Testcontainers tests in environments without Docker.
- **No real external calls in tests.** Mock the Kafka producer interface; use `miniredis` for Redis unit tests.

---

## Environment Variables

Config is validated at startup — the service refuses to start on any missing or malformed variable.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL DSN |
| `REDIS_URL` | Redis URL (for caching) |
| `KAFKA_BROKERS` | Comma-separated broker list |
| `KAFKA_CLIENT_ID` | Producer client ID |
| `GRPC_PORT` | Port to listen for gRPC connections |
| `HTTP_PORT` | Port for Echo HTTP server (default 3001) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel Collector endpoint |

---

## Hard Stops (inherit from root)

See [§15 Agent Hard Stops](../../docs/15-agent-hard-stops.md). Key items for this service:

- Do **not** run DB migrations against any non-local environment without explicit confirmation.
- Do **not** modify the Kafka topic partition count, replication factor, or retention without explicit confirmation.
- Do **not** hand-edit files in `libs/grpc-stubs/go/` — regenerate with `make proto`.
- Do **not** add a new Go module dependency (`go get`) without noting it and explaining why.
