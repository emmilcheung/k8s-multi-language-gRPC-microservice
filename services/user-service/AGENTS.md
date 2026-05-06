# user-service — Agent Guidelines

> Service-specific notes; defers to root [`/AGENTS.md`](../../AGENTS.md) on conflict.

## Service Identity

- **Role:** Owns user **profile, preferences, and billing address** data. Authentication and session/JWT issuance remain in `auth-service` — this service never mints tokens.
- **Stack:** TypeScript / Node.js + NestJS, pnpm-managed, Drizzle ORM (see `drizzle.config.ts`), Vitest for unit + integration tests.
- **Ports:** `3004` (host and container).
- **Datastore:** Owns one database; schema managed by Drizzle migrations under `migrations/`. No cross-DB queries (per root rule).

## Quick Commands

```bash
# install
pnpm install

# build
pnpm build

# test (unit)
pnpm test

# test (integration)
pnpm test:integration   # uses vitest.integration.config.ts

# lint
pnpm lint

# dev (local host run — requires explicit migrate first)
pnpm migrate
pnpm start:dev
```

Under Docker Compose and the production image, migrations run automatically before the app boots; if the schema is missing, startup fails loudly and `/healthz/ready` stays unavailable (per the "fail loud at startup" rule).

## Project Layout

```
src/                        ← NestJS modules, controllers, services
migrations/                 ← Drizzle migration files (forward-only)
drizzle.config.ts           ← Drizzle CLI config (schema path, dialect, credentials env)
nest-cli.json               ← NestJS build/dev config
vitest.config.ts            ← unit test config
vitest.integration.config.ts← integration test config (separate suite)
eslint.config.mjs           ← flat-config ESLint
Dockerfile                  ← multi-stage build; runs migrations before the app
```

## Endpoints

- `GET  /api/user-settings/profile`
- `PUT  /api/user-settings/profile`
- `GET  /api/user-settings/preferences`
- `PUT  /api/user-settings/preferences`
- `GET  /api/user-settings/billing-address`
- `PUT  /api/user-settings/billing-address`
- `GET  /healthz/live`
- `GET  /healthz/ready`

## Cross-Service Interactions

- **Identity in:** every `/api/user-settings/*` request requires `X-User-Id` (set by Kong's `jwt-sub.lua` post-function from the JWT `sub`). The service only reads/writes data for that caller — treat the header as the sole authorization signal.
- **Auth boundary:** `auth-service` issues the JWT and owns credentials; user-service holds **no** credentials or session state.
- **Events:** none — no Kafka producers or consumers wired in `src/`.

## Notes

- Never log the contents of `X-User-Id` alongside profile/billing payloads in a way that creates a PII trail — follow the root security guide on PII handling.
- Billing-address writes are user-data mutations: validate input strictly (Zod / class-validator) before persisting.
- The service must reject requests missing `X-User-Id` rather than fall back to anonymous reads.

For platform-wide standards (testing, security, observability, hard stops), see root [`/AGENTS.md`](../../AGENTS.md) TOC.
