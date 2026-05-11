# attendance-service

Admission boundary service for the QR-based attendance system. Manages event attendance policies, admission credentials, and scan events.

## Responsibilities

- Issues `AdmissionCredential` records when orders complete (via `orders.order.completed` Kafka events, WS2)
- Validates QR tokens and records scan events at check-in (WS2)
- Provides buyer admission pass queries via GraphQL and REST
- Provides organizer attendance policy management and summary reporting
- Exposes scanner endpoints for check-in by QR token or buyer identity fallback (WS2)

## Stack

- **Language:** Go
- **HTTP:** Echo v4
- **GraphQL:** gqlgen (Apollo Federation v2 subgraph)
- **Database:** PostgreSQL (golang-migrate embedded migrations)
- **Messaging:** Kafka (CloudEvents envelope)
- **Observability:** OpenTelemetry (OTLP), Prometheus, zap

## API Surface

### GraphQL (`/graphql`)

```graphql
query {
  admissionPass(ticketId: "...", orderId: "...") { id status issuedAt }
  attendancePolicy(eventId: "...") { requireQrForEntry allowManualOverride }
  attendanceSummary(eventId: "...") { totalAdmitted totalDenied }
}
```

### REST

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/attendance/tickets/:ticketId` | Buyer: get admission pass |
| GET | `/api/attendance/events/:eventId/settings` | Organizer: get policy |
| PATCH | `/api/attendance/events/:eventId/settings` | Organizer: update policy |
| GET | `/api/attendance/events/:eventId/summary` | Organizer: scan summary |
| GET | `/api/attendance/events/:eventId/checkins` | Organizer: list checked-in attendees |
| POST | `/api/attendance/scan/validate` | Scanner: validate token (WS2) |
| POST | `/api/attendance/scan/check-in` | Scanner: record check-in (WS2) |
| POST | `/api/attendance/scan/check-in-user` | Scanner: fallback check-in by buyer user ID |
| GET | `/healthz/live` | Liveness probe |
| GET | `/healthz/ready` | Readiness probe (Postgres + Kafka) |
| GET | `/metrics` | Prometheus metrics |

For this release, `eventId` is derived from ticket metadata and uses the ticket UUID as the event identifier until a separate event aggregate ID is introduced.

Email delivery is intentionally out of scope in this service. The follow-on shape is a separate `notification-service` that consumes `attendance.qr.issued` and sends buyer emails with hosted admission links.

## Configuration

See `.env.example` for all required environment variables.

## Running locally

```bash
cp .env.example .env
# Edit .env with your local values
go run ./cmd/server
```

## Tests

```bash
# Unit tests (fast, no Docker)
go test -short ./...

# Integration tests (requires Docker)
go test ./test/...
```

## Database schema

Managed by embedded SQL migrations in `internal/migrations/`:

- `event_attendance_policies` — per-event QR enforcement settings
- `admission_credentials` — issued credentials per ticket/order
- `scan_events` — audit log of every check-in attempt
