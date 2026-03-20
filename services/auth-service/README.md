# auth-service

Handles user identity for the platform. Issues short-lived RS256 JWTs stored in `httpOnly` cookies. Exposes a JWKS endpoint consumed by Kong for token verification.

## Responsibilities

- User signup and signin (argon2id password hashing)
- JWT issuance (RS256, 15-minute access tokens)
- JWKS endpoint for Kong token validation
- Current user identity forwarding (reads `X-User-Id` header injected by Kong)

## Ports

| Port | Purpose |
|------|---------|
| `3000` | HTTP API |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/users/signup` | Create account; sets `token` cookie |
| `POST` | `/api/users/signin` | Authenticate; sets `token` cookie |
| `POST` | `/api/users/signout` | Clears `token` cookie |
| `GET` | `/api/users/currentuser` | Returns user from `X-User-Id` header |
| `GET` | `/.well-known/jwks.json` | Public key for Kong JWT plugin |
| `GET` | `/healthz/live` | Liveness probe |
| `GET` | `/healthz/ready` | Readiness probe (checks DB) |
| `GET` | `/metrics` | Prometheus metrics |

## Environment Variables

See `.env.example` for the full list with descriptions.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `RSA_PRIVATE_KEY` | Yes | RSA 4096 private key (PEM or base64-encoded PEM) |
| `JWT_EXPIRY` | No | Token TTL (default: `15m`) |
| `PORT` | No | HTTP port (default: `3000`) |
| `NODE_ENV` | No | `development` / `production` / `test` |

## Local Development

```bash
# 1. Start all dev dependencies (Postgres, Kafka, Redis, etc.)
docker compose up -d

# 2. Copy and fill in env vars
cp .env.example .env
# Edit .env — add RSA private key (see .env.example for generation command)

# 3. Apply database migrations
npm run migrate

# 4. Start the service in watch mode
npm run start:dev
```

## Testing

```bash
# Unit tests
npm test

# Integration tests (requires Docker — spins up a real Postgres via Testcontainers)
npm run test:integration

# Coverage report
npm run test:cov
```

## Database Migrations

Migrations are plain SQL files in `migrations/`. Managed by `node-pg-migrate`.

```bash
# Apply all pending migrations
DATABASE_URL=<url> npm run migrate
```

In production, migrations are applied by an init container before the service pod starts.

## Building

```bash
# TypeScript compile check
npm run build

# Docker image (multi-stage, non-root, pinned digest)
docker build -t auth-service:local .
```
