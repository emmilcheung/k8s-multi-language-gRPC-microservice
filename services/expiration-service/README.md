# expiration-service

Handles order expiration. Consumes `orders.order.created` events from Kafka,
schedules a delayed job (via asynq + Redis) to fire at the order's `expiresAt`
time, and then publishes an `expiration.order.expiration_complete` event so
`order-service` can transition the order to `CANCELLED`.

## Responsibilities

- **Consume** `orders.order.created` — extract `orderId` and `expiresAt`.
- **Schedule** a Redis-backed asynq delayed task keyed by `orderId` (idempotent).
- **Process** the task when it fires and **publish** `expiration.order.expiration_complete`.
- Expose `/healthz/live`, `/healthz/ready`, and `/metrics` (Prometheus).

## Topics

| Direction | Topic | Key |
|---|---|---|
| Consume | `orders.order.created` | `orderId` |
| Produce | `expiration.order.expiration_complete` | `orderId` |
| DLQ | `expiration.order.expiration_complete.dlq` | — |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_ADDR` | yes | — | Redis host:port used by asynq |
| `KAFKA_BROKERS` | yes | — | Comma-separated Kafka broker addresses |
| `PORT` | no | `8080` | HTTP port for health and metrics |
| `APP_ENV` | no | `development` | Environment name |
| `LOG_LEVEL` | no | `info` | Zap log level (debug/info/warn/error) |

## Running Locally

```bash
cp .env.example .env
# Edit .env with real values
source .env
go run ./cmd/server
```

Requires Docker Compose infrastructure (`docker-compose.yml` at repo root):

```bash
docker compose up -d redis kafka
```

## Testing

```bash
# Unit tests only (no Docker required)
go test ./internal/... -v

# Integration tests (requires Docker)
go test ./test/... -v -timeout 3m
```

## Build

```bash
CGO_ENABLED=1 go build -o expiration-service ./cmd/server
```

## Docker

```bash
docker build -t expiration-service .
docker run -e REDIS_ADDR=redis:6379 -e KAFKA_BROKERS=kafka:9092 expiration-service
```

## Architecture

```
orders.order.created (Kafka)
        │
        ▼
  Kafka Consumer
        │
        ▼
   Scheduler (asynq client)
        │  enqueue task keyed by orderId
        ▼
   Redis (asynq queue)
        │  fires at expiresAt
        ▼
   Worker (asynq server)
        │
        ▼
   Kafka Producer
        │
        ▼
expiration.order.expiration_complete (Kafka)
        │
        ▼
  order-service → CANCELLED
```
