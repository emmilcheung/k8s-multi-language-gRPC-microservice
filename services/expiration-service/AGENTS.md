# expiration-service — Agent Guidelines

> **Source of truth:** [`/AGENTS.md`](../../AGENTS.md) at the monorepo root.
> These notes extend and specialise the root guidelines for this service.
> When anything here conflicts with the root, the **root wins**.

---

## Service Identity

| Field | Value |
|---|---|
| **Role** | Order expiration — schedules delayed jobs; emits `expiration.order.expired` events when order TTLs elapse |
| **Language** | Go 1.25+ |
| **Framework** | Echo v4 (HTTP health/metrics) |
| **Module** | `github.com/acme/expiration-service` |
| **Test tooling** | `testify` + `testcontainers-go` |
| **Queue / scheduler** | `asynq` (backed by Redis) |
| **Cache / queue store** | Redis (`go-redis/v9`) |
| **Messaging** | Kafka producer (`confluent-kafka-go/v2`) |
| **HTTP port** | Internal (health/metrics only — no public API) |

---

## Quick Commands

```bash
# Build
go build ./...

# Run all tests (unit + integration)
go test ./...

# Run only unit tests (skip Testcontainers)
go test -short ./...

# Vet (must pass before push)
go vet ./...

# Run service locally
go run ./cmd/server
```

---

## Project Layout

```
cmd/
  server/
    main.go             ← entry-point; validates config, wires Redis + Kafka + asynq + Echo
internal/
  config/               ← env var parsing + validation (fail loudly at startup)
  health/               ← GET /healthz/live + GET /healthz/ready
  kafka/                ← Kafka producer setup + message publishing helpers
  scheduler/            ← enqueue delayed jobs into asynq (Redis-backed)
  server/               ← Echo server setup (health, metrics endpoints only)
  tracing/              ← OpenTelemetry SDK bootstrap
  worker/
    worker.go           ← asynq worker — processes expired job tasks
    worker_test.go
pkg/                    ← exportable helpers (event types, constants)
test/                   ← integration tests (Testcontainers)
```

---

## Go Conventions

Same general Go conventions as the Go services — see [ticket-service AGENTS.md](../ticket-service/AGENTS.md#go-conventions). Key reminders:

- **Never swallow errors.** `_ = err` is forbidden. Every error must be checked and propagated or logged.
- **Wrap errors with context:** `fmt.Errorf("enqueueExpiration: %w", err)`.
- **`context.Context` as first argument** throughout the call chain. Honour cancellations in the asynq handler.
- **No global mutable state.** Inject Redis client, Kafka producer, and scheduler via constructor.
- **Table-driven tests** for all unit-testable functions.

---

## asynq — Delayed Job Scheduler Rules

- **asynq** uses Redis as its backing store (sorted sets for scheduled tasks). Do not use it as a Kafka replacement — it is a local scheduling mechanism, not a cross-service bus.
- **Task payload must be idempotent** — the same task may be executed more than once if a worker crashes mid-processing.
- **Task type naming:** `expiration:<entity>:expire` e.g. `expiration:order:expire`.
- **Enqueue with TTL = order expiration deadline** minus current time. The scheduler enqueues when an order is created (triggered by a Kafka `orders.order.created` event consumed elsewhere, or via direct API from order-service — confirm the exact trigger with the team).
- **On task execution:** verify the order is still in a cancellable state before producing the Kafka event (check idempotency key in Redis or accept that order-service consumer will handle duplicates).
- **Do not block the asynq worker goroutine** on Kafka producer calls. Use a timeout context (10 s max per the timeout table in [§09](../../docs/09-error-handling.md)).

---

## Kafka — Producer Rules

> Full messaging guide: [`docs/04-asynchronous-messaging.md`](../../docs/04-asynchronous-messaging.md)

- Topic produced: `expiration.order.expired`.
- Partition key = `orderId`.
- Producer config: `acks=all`, `enable.idempotence=true`.
- CloudEvents v1.0 envelope on every message.
- On producer failure: log at `ERROR` with `orderId` (no PII), retry up to 3 times with exponential back-off, then record the failure for manual replay — **never silently discard**.

---

## Redis Rules

> Full data guide: [`docs/05-data-conventions.md#redis-conventions`](../../docs/05-data-conventions.md)

- asynq manages its own key namespace in Redis — do not manually mutate asynq keys.
- Additional cache keys follow: `expiration-service:<entity>:<id>`.
- **Always set a TTL** on any key this service writes directly.
- **Never store sensitive data** in Redis.
- Redis errors must surface as operational errors — not unhandled panics.

---

## Security

> Full security guide: [`docs/06-security.md`](../../docs/06-security.md)

- This service has **no public HTTP API** (health/metrics only). It is not reachable via Kong.
- Any trigger input (e.g. order ID from an internal Kafka consumer) must be **validated** (UUID format check) before being used in Redis key construction or Kafka payloads.
- **No user-controlled data in log fields** without sanitisation.

---

## Observability

> Full observability guide: [`docs/08-observability.md`](../../docs/08-observability.md)

- Structured JSON logging via `go.uber.org/zap`. Every log entry must carry `traceId`, `spanId`, `service=expiration-service`.
- `tracing.go` bootstraps the OTel SDK — call before starting Echo and the asynq server.
- Prometheus metrics via `echo-contrib`; exposed at `GET /metrics`.
- RED metrics: `kafka_messages_produced_total`, `asynq_tasks_processed_total`, `asynq_task_processing_duration_seconds`.
- Health: `GET /healthz/live` (always 200) and `GET /healthz/ready` (checks Redis connectivity + Kafka broker reachability).

---

## Testing

> Full testing guide: [`docs/13-testing.md`](../../docs/13-testing.md)

- **Unit tests** (`worker_test.go`, etc.): mock the Kafka producer and Redis client via interfaces. Test that the worker correctly calls the producer with the right payload on a trigger.
- **Integration tests** (`test/`): use Testcontainers for a real Redis instance. Use `miniredis` for lightweight unit-level Redis testing.
- Test naming: `TestDoSomething_ShouldBehave_WhenCondition`.
- **No real Kafka calls in unit tests.** Mock the producer interface.
- Use `-short` flag to skip Testcontainers tests in environments without Docker.

---

## Environment Variables

Config is parsed and validated at startup — the service refuses to start if any required variable is missing.

| Variable | Purpose |
|---|---|
| `REDIS_URL` | Redis URL (asynq + any direct cache use) |
| `KAFKA_BROKERS` | Comma-separated Kafka broker list |
| `KAFKA_CLIENT_ID` | Producer client ID |
| `HTTP_PORT` | Port for Echo health/metrics (default internal port) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel Collector endpoint |

---

## Hard Stops (inherit from root)

See [§15 Agent Hard Stops](../../docs/15-agent-hard-stops.md). Key items for this service:

- Do **not** flush or wipe the asynq Redis keyspace without explicit confirmation — this would delete all pending expiration jobs.
- Do **not** modify Kafka topic configuration without explicit confirmation.
- Do **not** add a new Go module dependency without noting it and explaining why.
