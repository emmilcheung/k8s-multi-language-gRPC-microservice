# ticket-service

Manages the lifecycle of tickets in the platform. Each ticket represents an event seat or item that can be listed, reserved, and purchased.

## Responsibilities

- CRUD operations for tickets (`POST`, `GET`, `PUT /api/tickets`)
- Publishes `tickets.ticket.created` and `tickets.ticket.updated` CloudEvents to Kafka
- Ownership enforcement — only the creating user may update their ticket
- Reservation guard — reserved tickets (attached to an order) cannot be edited

## Tech Stack

| Concern | Choice |
|---|---|
| Language | Go 1.23+ |
| HTTP Framework | Echo v4 |
| Database | MongoDB 7 (owns `tickets` collection) |
| Messaging | Kafka (producer only) |
| Logging | zap (structured JSON) |
| Metrics | Prometheus (`/metrics`) |
| Tests | testify + testcontainers-go |

## API

### `POST /api/tickets`
Create a new ticket. Requires `X-User-Id` header (injected by Kong).

**Request:**
```json
{ "title": "Concert Ticket", "price": 29.99 }
```

**Response `201`:**
```json
{
  "id": "uuid",
  "title": "Concert Ticket",
  "price": 29.99,
  "userId": "user-123",
  "version": 1,
  "createdAt": "2026-03-20T12:00:00Z",
  "updatedAt": "2026-03-20T12:00:00Z"
}
```

### `GET /api/tickets`
List all tickets. Returns `[]` when empty.

### `GET /api/tickets/:id`
Fetch a single ticket by UUID. Returns `404` if not found.

### `PUT /api/tickets/:id`
Update title and price. Returns:
- `403` if the requesting user does not own the ticket
- `409` if the ticket is reserved (has an active order)
- `404` if the ticket does not exist

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `APP_ENV` | No | `development` | Environment name |
| `PORT` | No | `3001` | HTTP listen port |
| `LOG_LEVEL` | No | `info` | Logging level (debug/info/warn/error) |
| `MONGO_URI` | **Yes** | — | MongoDB connection URI |
| `MONGO_DB` | No | `tickets` | MongoDB database name |
| `KAFKA_BROKERS` | **Yes** | — | Comma-separated Kafka broker addresses |

## Running Locally

```bash
cp .env.example .env
# Edit .env with real values

# Start infrastructure (from repo root)
docker compose up -d mongodb kafka

# Run the service
go run ./cmd/server
```

## Testing

```bash
# Unit tests (no external dependencies)
go test ./internal/...

# Integration tests (requires Docker — starts MongoDB via Testcontainers)
go test ./test/... -timeout 120s
```

## Kafka Events

### `tickets.ticket.created`
Published after a ticket is successfully created.

```json
{
  "specversion": "1.0",
  "type": "tickets.ticket.created",
  "source": "ticket-service",
  "id": "<uuid>",
  "time": "2026-03-20T12:00:00Z",
  "datacontenttype": "application/json",
  "data": {
    "id": "ticket-uuid",
    "title": "Concert Ticket",
    "price": 29.99,
    "userId": "user-123",
    "version": 1
  }
}
```

### `tickets.ticket.updated`
Published after a ticket is successfully updated. Same envelope structure as above.

## Health Checks

| Endpoint | Purpose |
|---|---|
| `GET /healthz/live` | Liveness — always `200` if process is running |
| `GET /healthz/ready` | Readiness — `200` if MongoDB is reachable, `503` otherwise |
