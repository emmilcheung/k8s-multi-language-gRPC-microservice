# auth-service

Handles user identity for the platform. Issues short-lived RS256 JWTs stored in `httpOnly` cookies. Exposes a JWKS endpoint consumed by Kong for token verification.

## Responsibilities

- User signup and signin (argon2id password hashing)
- Redis-backed sign-in abuse protection with temporary lockouts
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
| `POST` | `/api/auth/refresh` | Rotates refresh token and reissues access token |
| `GET` | `/api/users/sessions` | List active refresh-token-backed sessions for the current user |
| `DELETE` | `/api/users/sessions/:sessionId` | Revoke a specific session |
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
| `JWT_COOKIE_NAME` | No | Access-token cookie name (default: `token`) |
| `REFRESH_COOKIE_NAME` | No | Refresh-token cookie name (default: `refreshToken`) |
| `REFRESH_TOKEN_TTL_SECONDS` | No | Refresh-token TTL and cookie max-age (default: `604800`) |
| `SIGNIN_FAILURE_WINDOW_SECONDS` | No | Rolling window for failed sign-in counting (default: `900`) |
| `SIGNIN_MAX_FAILURES` | No | Failed sign-ins allowed in the window before lockout (default: `5`) |
| `SIGNIN_LOCKOUT_SECONDS` | No | Temporary lockout duration after too many failures (default: `900`) |
| `REFRESH_COOKIE_PATH` | No | Refresh cookie path scope (default: `/`) |
| `ACCESS_TOKEN_COOKIE_SAME_SITE` | No | Access-token SameSite policy (`strict/lax/none`) |
| `REFRESH_TOKEN_COOKIE_SAME_SITE` | No | Refresh-token SameSite policy (`strict/lax/none`) |
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
