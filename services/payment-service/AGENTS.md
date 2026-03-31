# payment-service — Agent Guidelines

> **Source of truth:** [`/AGENTS.md`](../../AGENTS.md) at the monorepo root.
> These notes extend and specialise the root guidelines for this service.
> When anything here conflicts with the root, the **root wins**.

---

## Service Identity

| Field | Value |
|---|---|
| **Role** | Payment processing — consumes `orders.order.created` events, charges via Stripe, emits `payments.payment.captured` |
| **Language** | TypeScript / Node.js 24 LTS |
| **Framework** | NestJS 11 |
| **Package manager** | pnpm 10 |
| **Test runner** | Vitest |
| **Database** | PostgreSQL via Drizzle ORM |
| **Messaging** | Kafka consumer + producer (`kafkajs`) |
| **External dependency** | Stripe (`stripe` SDK) |
| **Pattern** | Transactional outbox relay (`outbox-relay.service.ts`) |
| **HTTP port** | 3002 |

---

## Quick Commands

```bash
# Install dependencies
pnpm install

# Run in dev (watch mode)
pnpm start:dev

# Run unit tests
pnpm test

# Run integration tests (requires Postgres + Kafka running)
pnpm test:integration

# Lint (must pass before push)
pnpm lint && pnpm tsc --noEmit

# Generate a new DB migration
pnpm migrate:generate

# Apply pending migrations
pnpm migrate
```

---

## Project Layout

```
src/
  main.ts                       ← bootstrap; validates env at startup (fail loudly)
  app.module.ts
  tracing.ts                    ← OTel SDK init — must be first import in main.ts
  common/                       ← shared filters, interceptors, pipes
  database/                     ← Drizzle client, schema, connection pool
  kafka/                        ← KafkaJS consumer/producer modules
  migrate.ts
  modules/
    payments/
      payments.controller.ts    ← thin; delegates to service
      payments.service.ts       ← orchestrates Stripe charge + DB write + outbox insert
      payments.repository.ts    ← DB access only
      payments.dto.ts           ← class-validator DTOs
      outbox-relay.service.ts   ← polls outbox table, publishes to Kafka, deletes on ack
      stripe.constants.ts       ← Stripe event type constants
    health/                     ← GET /healthz/live + GET /healthz/ready
    metrics/                    ← Prometheus /metrics
migrations/                     ← append-only SQL files
test/                           ← integration tests (Vitest + Testcontainers)
```

---

## NestJS Conventions

Same base conventions as all NestJS services — see [auth-service AGENTS.md](../auth-service/AGENTS.md#nestjs-conventions). Key reminders:

- Controllers are **thin** — delegate to service layer.
- Business logic in `*.service.ts`; DB access isolated in `*.repository.ts`.
- **ValidationPipe globally configured** with `whitelist: true, forbidNonWhitelisted: true`.
- Throw typed NestJS exceptions from services — never raw `Error` for operational cases.
- Config validated via Zod in `ConfigModule` at startup.

---

## Kafka — Consumer & Producer Rules

> Full messaging guide: [`docs/04-asynchronous-messaging.md`](../../docs/04-asynchronous-messaging.md)

### Consumer

- Consumes: `orders.order.created` (and `orders.order.cancelled` for refund flows if applicable).
- Consumer group ID: `payment-service`.
- **Idempotency is mandatory.** The same event can be delivered more than once — check whether a payment record already exists for the `orderId` before processing.
- Commit offsets **after** successful processing (not before).
- On failure: retry with exponential back-off (max 3 attempts), then route to DLT `orders.order.created.dlq`. Never discard a message silently.
- Separate Kafka polling/offset management from business logic handler functions.

### Producer (via outbox relay)

- Following the **transactional outbox pattern**: inside the payment DB transaction, insert a row into the `outbox` table alongside the payment record. The `OutboxRelayService` (a scheduled NestJS task via `@nestjs/schedule`) polls the outbox, publishes to Kafka, and deletes rows on successful acknowledgement.
- Topic produced: `payments.payment.captured`.
- Partition key = `orderId`.
- Producer config: `acks: -1` (all), `idempotent: true`.
- CloudEvents envelope required on every published message.

---

## Stripe Integration Rules

- **Never log or store raw Stripe webhook payloads** in plaintext if they contain card data.
- **Always verify the webhook signature** (`stripe.webhooks.constructEvent`) before processing any Stripe-originated event. Reject requests without a valid `Stripe-Signature` header with `400`.
- Stripe API key is read from env var `STRIPE_SECRET_KEY` — never hardcode or commit it.
- Idempotency keys for Stripe API calls: use the `orderId` as the idempotency key to prevent double charges on retries.
- Map Stripe errors to appropriate HTTP responses: `card_declined` → `402`, `invalid_request_error` → `400`, network errors → `503`.

---

## Database — Drizzle ORM Rules

> Full data guide: [`docs/05-data-conventions.md`](../../docs/05-data-conventions.md)

- Migration files are **append-only and immutable** after merge to `main`.
- Schema defined in `src/database/schema.ts` — single source of truth.
- **Never `SELECT *`** — name columns explicitly in Drizzle queries.
- UUID primary keys everywhere.
- `created_at` / `updated_at` on every table.
- The `outbox` table must be part of the same schema and migration lifecycle.
- **No cross-service DB access** — this service owns its own PostgreSQL instance exclusively.

---

## Security

> Full security guide: [`docs/06-security.md`](../../docs/06-security.md)

- This service **never validates JWTs.** Kong validates the token upstream; `X-User-Id` and `X-User-Roles` are trusted forwarded headers.
- **Ownership check:** verify the `X-User-Id` matches the order's `userId` before initiating a payment.
- Stripe webhook endpoint must **not** be routed through Kong's JWT plugin — it must use Stripe signature verification instead.
- **Input validation** on all DTOs: use `class-validator` with `forbidNonWhitelisted: true`.
- **ISO 4217 currency code validation** on any amount field — reject unknown currency strings.
- **Never log PII** (card numbers, email addresses) or secrets (`STRIPE_SECRET_KEY`).

---

## Observability

> Full observability guide: [`docs/08-observability.md`](../../docs/08-observability.md)

- `tracing.ts` **must be the first import** in `main.ts` before any NestJS module.
- Structured JSON logs via `nestjs-pino`; every log line includes `traceId`, `spanId`, `service=payment-service`.
- Prometheus at `GET /metrics`.
- RED metrics: `http_requests_total`, `http_request_duration_seconds`, `kafka_consumer_lag`.
- Health: `GET /healthz/live` and `GET /healthz/ready` (checks DB + Kafka broker connectivity).

---

## Testing

> Full testing guide: [`docs/13-testing.md`](../../docs/13-testing.md)

- **Unit tests** (`*.spec.ts`): mock Stripe SDK, Kafka producer, and DB repository. Use `vi.fn()` / `vi.mock()`.
- **Integration tests** (`test/`): Testcontainers for real PostgreSQL + Kafka. Use a Stripe test mode key (injected via env) — never a live key in tests.
- Test naming: `<subject> should <behaviour> when <condition>`.
- **Never make real Stripe charges in tests.** Use Stripe test cards and test mode; or mock the `stripe` module entirely in unit tests.
- Validate outbox relay end-to-end in integration tests: insert a payment, confirm the outbox record, trigger relay, confirm Kafka message produced.

---

## Environment Variables

Validated at startup via Zod — service refuses to start if any required var is missing.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `KAFKA_BROKERS` | Comma-separated Kafka broker list |
| `KAFKA_CLIENT_ID` | KafkaJS client ID |
| `KAFKA_GROUP_ID` | Consumer group ID (`payment-service`) |
| `STRIPE_SECRET_KEY` | Stripe secret API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel Collector endpoint |
| `NODE_ENV` | `development` \| `production` \| `test` |

---

## Hard Stops (inherit from root)

See [§15 Agent Hard Stops](../../docs/15-agent-hard-stops.md). Key items for this service:

- Do **not** run `pnpm migrate` against a non-local database without explicit confirmation.
- Do **not** log or print `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, or `DATABASE_URL`.
- Do **not** modify Kafka topic configuration without explicit confirmation.
- Do **not** add a new `pnpm` dependency without noting it and explaining why.
