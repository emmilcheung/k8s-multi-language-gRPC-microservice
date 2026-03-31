# auth-service — Agent Guidelines

> **Source of truth:** [`/AGENTS.md`](../../AGENTS.md) at the monorepo root.
> These notes extend and specialise the root guidelines for this service.
> When anything here conflicts with the root, the **root wins**.

---

## Service Identity

| Field | Value |
|---|---|
| **Role** | Authentication & authorisation — issues RS256-signed JWTs, manages refresh tokens |
| **Language** | TypeScript / Node.js 24 LTS |
| **Framework** | NestJS 11 |
| **Package manager** | pnpm 10 |
| **Test runner** | Vitest |
| **Database** | PostgreSQL via Drizzle ORM (`drizzle-orm`, migrations with `drizzle-kit`) |
| **Cache / session** | Redis (`ioredis`) — refresh token store |
| **HTTP port** | 3000 |

---

## Quick Commands

```bash
# Install dependencies
pnpm install

# Run in dev (watch mode)
pnpm start:dev

# Run unit tests
pnpm test

# Run integration tests (requires Postgres + Redis running)
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
  main.ts                 ← bootstrap; validates all env vars at startup (fail loudly)
  app.module.ts
  tracing.ts              ← OpenTelemetry SDK initialisation (imported before anything else)
  common/                 ← shared guards, pipes, interceptors, filters
  database/               ← Drizzle client, schema files, connection pool
  migrate.ts              ← CLI entry-point for drizzle-kit
  modules/
    auth/                 ← sign-up, sign-in, token refresh, sign-out
    users/                ← user repository (read-only via other modules)
    health/               ← GET /healthz/live  +  GET /healthz/ready
    metrics/              ← Prometheus /metrics endpoint
    redis/                ← Redis module / provider
migrations/               ← append-only SQL migration files (never edit after merge)
test/                     ← integration tests (Vitest + Testcontainers)
```

---

## NestJS Conventions

- **Module boundary is the unit of ownership.** Every domain concept lives inside its own module folder. Never import directly from another module's internals — use the module's exported providers.
- **Always use the NestJS DI container.** Do not instantiate services with `new` outside tests.
- **DTOs use `class-validator` + `class-transformer`.** Apply `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` globally — unknown fields must be rejected (security requirement).
- **Zod** is used for config schema validation in `ConfigModule` (`zod.parse` at startup).
- **Controllers are thin.** Business logic belongs in the `*.service.ts`; DB access belongs in `*.repository.ts`.
- **Error handling:** throw NestJS built-in exceptions (`NotFoundException`, `UnauthorizedException`, `ConflictException`, etc.) from services. The global exception filter maps them to the canonical error response format (see [§03 API Design](../../docs/03-api-design.md)).
- **Never throw a raw `Error`** from a controller or service for operational errors — use the typed NestJS exceptions so the filter can produce the correct HTTP status.

---

## Security — Auth-Specific Rules

> Full security guidelines: [`docs/06-security.md`](../../docs/06-security.md)

- **Password hashing:** `argon2` (argon2id variant). Never bcrypt, never MD5/SHA-* alone.
- **JWT signing:** RS256 asymmetric keys. Private key is injected via env var `JWT_PRIVATE_KEY` (PEM, base64). Public key exposed at `GET /v1/auth/.well-known/jwks.json` (JWKS endpoint).
- **Refresh tokens:** stored as short-lived Redis keys (`auth-service:refresh:<tokenHash>`). On sign-out, delete the key. Never store raw tokens — store a hash.
- **Access tokens are short-lived** (15 min default). Refresh tokens are longer (7 days). Both TTLs are env-configurable.
- **Trust forwarded headers only downstream from Kong.** This service sits behind Kong; downstream services receive `X-User-Id` and `X-User-Roles` from the Kong JWT plugin — this service is the one issuing the JWT content, not consuming headers.
- **Input validation at every endpoint.** Any endpoint that accepts user input must use `class-validator` on the DTO. Reject unknown fields.
- **No sensitive data in logs.** Never log passwords, tokens, or PII. Use `pino` redact paths for `password`, `token`, `authorization`.

---

## Database — Drizzle ORM Rules

> Full data conventions: [`docs/05-data-conventions.md`](../../docs/05-data-conventions.md)

- **Migration files are append-only.** Once merged to `main`, a migration file is immutable. Use `drizzle-kit generate` for new migrations; never hand-edit a generated file.
- **Schema lives in `src/database/schema.ts`** (or per-entity files imported there). Keep it as the single source of truth — do not define tables elsewhere.
- **Never use `SELECT *`.** Name columns explicitly in every Drizzle query.
- **UUID primary keys** everywhere. No serial/auto-increment integers exposed via API.
- **`created_at` and `updated_at`** on every table, managed via Drizzle `defaultNow()` / `$onUpdateFn`.
- **Parameterised queries only.** Drizzle's query builder uses parameterised SQL by default — never interpolate user input into raw SQL strings.

---

## Redis Rules

- Cache key pattern: `auth-service:<entity>:<id>` e.g. `auth-service:refresh:<hash>`.
- **Always set a TTL.** No key is stored without an expiry.
- **Never store raw secrets.** Store a SHA-256 hash of the refresh token, not the token value itself.
- Redis errors must not crash the service — if Redis is unavailable, fail the specific operation with a `503` (or allow the request to proceed without caching if appropriate), but do not let a Redis connection failure propagate as an uncaught exception.

---

## Observability

> Full observability guide: [`docs/08-observability.md`](../../docs/08-observability.md)

- Structured JSON logging via `nestjs-pino`. Every log line must include `traceId` and `spanId` automatically (pino-http injects from the active OTel span).
- `tracing.ts` **must be imported as the first statement in `main.ts`** before any NestJS import — otherwise auto-instrumentation patches may not apply.
- Prometheus metrics exposed at `GET /metrics` via `@willsoto/nestjs-prometheus`.
- RED metrics to track: `http_requests_total`, `http_request_duration_seconds` (labelled by `method`, `route`, `status_code`).
- Health endpoints: `GET /healthz/live` (always 200 if process running) and `GET /healthz/ready` (checks DB + Redis connectivity).

---

## Testing

> Full testing guide: [`docs/13-testing.md`](../../docs/13-testing.md)

- **Unit tests** (`*.spec.ts`): pure business logic, no I/O. Mock DB repositories and Redis using Vitest `vi.fn()` / `vi.mock()`.
- **Integration tests** (`test/*.integration.spec.ts`): use Testcontainers to spin up real PostgreSQL and Redis instances. Each test suite rolls back or wipes its own data.
- Test naming: `<subject> should <behaviour> when <condition>`.
- Run `pnpm test` (unit) in CI first; `pnpm test:integration` requires Docker and runs separately.
- **Never commit a test that makes real external network calls** (no calls to real Stripe, real email providers, etc.).

---

## Environment Variables

All required env vars are validated at startup via Zod in `ConfigModule`. The service **refuses to start** if any required variable is missing or malformed.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_PRIVATE_KEY` | RS256 private key (PEM, base64-encoded) |
| `JWT_PUBLIC_KEY` | RS256 public key (PEM, base64-encoded) |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL (e.g. `15m`) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL (e.g. `7d`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel Collector endpoint |
| `NODE_ENV` | `development` \| `production` \| `test` |

Never commit `.env` files. Use `infra/local/secrets.env` (git-ignored) locally.

---

## Hard Stops (inherit from root)

See [§15 Agent Hard Stops](../../docs/15-agent-hard-stops.md). Key items for this service:

- Do **not** run `pnpm migrate` against a non-local database without explicit confirmation.
- Do **not** log or print `JWT_PRIVATE_KEY`, `DATABASE_URL`, or any credential at any log level.
- Do **not** add a new `pnpm` dependency without noting it and explaining why.
