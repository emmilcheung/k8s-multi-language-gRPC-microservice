# Payment Service

Processes payments for confirmed orders using Stripe PaymentIntents. Observes `orders.order.created` events from Kafka and exposes a REST API for the client to trigger charges.

## Responsibilities

- Charge a payment method via Stripe (idempotent — one payment per order)
- In real mode, initiate payments only from `POST /api/payments`
- In mock mode, auto-complete `orders.order.created` events for local and integration flows
- Publish `payments.payment.captured` or `payments.payment.failed` events (planned)
- Own the `payments` PostgreSQL database — no other service accesses it

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 24 LTS |
| Framework | NestJS 11 |
| Language | TypeScript |
| Database | PostgreSQL (Drizzle ORM) |
| Messaging | Kafka (KafkaJS) |
| Payment processor | Stripe |
| Package manager | pnpm |
| Test runner | Vitest |

## Port

`3001`

## API endpoints

All external endpoints are exposed through the Kong API Gateway.

### `POST /api/payments`

Charge a payment method for an order.

**Headers**

| Header | Description |
|---|---|
| `x-user-id` | UUID of the authenticated user (injected by Kong) |

**Request body**

```json
{
  "orderId": "uuid",
  "token": "pm_card_visa"
}
```

- `orderId` — UUID of the order being paid
- `token` — Stripe PaymentMethod ID from client-side Stripe.js

The service resolves order ownership, status, and amount from order-service before creating a charge. Client-supplied pricing is rejected.

Real Stripe charges are status-aware: the service only marks a payment `completed` when Stripe returns a succeeded PaymentIntent or the verified webhook confirms success. Non-terminal Stripe states remain `pending` until the webhook settles them.

**Responses**

| Status | Description |
|---|---|
| `201 Created` | Payment created and charge initiated |
| `400 Bad Request` | Validation failure |
| `404 Not Found` | Order not found or not owned by the caller |
| `409 Conflict` | Order is not payable in its current state |
| `503 Service Unavailable` | Order verification failed |
| `500 Internal Server Error` | Unexpected error |

**Success response body**

```json
{
  "id": "uuid",
  "orderId": "uuid",
  "userId": "user-id",
  "amount": 1000,
  "currency": "usd",
  "status": "completed",
  "stripePaymentIntentId": "pi_...",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

---

### `GET /api/payments/:id`

Retrieve a payment by its ID.

**Responses**

| Status | Description |
|---|---|
| `200 OK` | Payment record returned |
| `404 Not Found` | No payment with that ID |

---

### `GET /healthz/live`

Liveness probe — returns `200` if the process is running.

### `GET /healthz/ready`

Readiness probe — returns `200` when PostgreSQL and Kafka are reachable, `503` otherwise.

### `GET /metrics`

Prometheus metrics endpoint (RED method: request rate, error rate, duration).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | `development` \| `production` (default: `development`) |
| `PORT` | No | HTTP port (default: `3001`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DB_POOL_MAX` | No | PostgreSQL pool max connections (default: `20`) |
| `ORDER_SERVICE_URL` | Yes | Base URL for order-service used to verify order ownership and amount |
| `ORDER_SERVICE_TIMEOUT_MS` | No | Order lookup timeout in milliseconds (default: `5000`) |
| `ORDER_SERVICE_RETRY_ATTEMPTS` | No | Number of retry attempts for transient order lookup failures (default: `2`) |
| `ORDER_SERVICE_RETRY_BASE_DELAY_MS` | No | Base backoff delay in milliseconds for order lookup retries (default: `100`) |
| `ORDER_SERVICE_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | No | Consecutive failed lookups before the local circuit breaker opens (default: `3`) |
| `ORDER_SERVICE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | No | Cooldown in milliseconds before the order lookup breaker allows traffic again (default: `30000`) |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key. Set to `test_mock` to skip real Stripe calls in tests. In mock mode, sending token `pm_mock_declined` forces a deterministic failed payment for E2E and QA scenarios. |
| `STRIPE_WEBHOOK_SECRET` | Conditionally required | Required in production for webhook signature verification. |
| `KAFKA_BROKERS` | Yes | Comma-separated Kafka broker addresses (e.g. `localhost:9092`) |

Copy `.env.example` to `.env` and fill in values. Never commit `.env`.

## Database schema

Single table: `payments`

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` (PK) | Auto-generated UUID v4 |
| `order_id` | `uuid` (unique) | The order being paid — enforces one payment per order |
| `user_id` | `text` | User who owns the order |
| `amount` | `integer` | Amount in smallest currency unit |
| `currency` | `text` | ISO 4217 currency code |
| `status` | `text` | `pending` \| `completed` \| `failed` |
| `stripe_payment_intent_id` | `text` (nullable) | Set once the Stripe charge is created |
| `created_at` | `timestamptz` | Auto-set on insert |
| `updated_at` | `timestamptz` | Auto-set on insert (update via application) |

Migrations live in `migrations/` and are applied via an init container or CI step before the service starts.

## Kafka

### Consumed topics

| Topic | Action |
|---|---|
| `orders.order.created` | In mock mode, auto-complete a payment for local/test flows; in real mode, record the signal and wait for `POST /api/payments` |

Consumer group: `payment-service`

Failed messages (after 3 exponential-back-off retries) are routed to `orders.order.created.dlq`.

### Produced topics (planned)

| Topic | Trigger |
|---|---|
| `payments.payment.captured` | Successful charge |
| `payments.payment.failed` | Stripe charge failure |

## Running locally

```bash
# 1. Start dependencies (Postgres, Kafka)
docker compose up -d postgres-payments kafka

# 2. Install dependencies
pnpm install

# 3. Copy env file and fill in values
cp .env.example .env

# 4. Apply migrations for host-run development
pnpm migrate

# 5. Start in watch mode
pnpm start:dev
```

When running under Docker Compose or the container image, migrations are applied automatically by `node dist/migrate` before the NestJS process starts. Readiness stays red if the required tables are missing.

## Testing

```bash
# Unit tests
pnpm test

# Unit tests with coverage
pnpm test:cov

# Integration tests (requires Docker — spins up real PostgreSQL)
pnpm test:integration
```

- Unit tests: 14 passing
- Integration tests: 11 passing
