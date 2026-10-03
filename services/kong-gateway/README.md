# kong-gateway

Kong API Gateway configuration for the ticketing platform, structured as a first-class service with multi-environment support.

## Directory layout

```
services/kong-gateway/
├── config/
│   └── kong.base.yml          # Base template — do not use directly
├── plugins/
│   └── jwt-sub.lua            # JWT sub → X-User-Id extractor (single canonical copy)
├── values/
│   ├── _defaults.yml          # Default values for all environments
│   ├── local.yml              # Docker Compose overrides
│   ├── minikube.yml           # Local Kubernetes (minikube) overrides
│   ├── dev.yml                # EKS dev overrides
│   ├── staging.yml            # EKS staging overrides
│   └── prod.yml               # EKS production overrides
├── scripts/
│   ├── build.sh               # Renders kong.yml from template + values + env
│   ├── validate.sh            # Validates a rendered kong.yml via `kong config parse`
│   └── docker-entrypoint.sh   # Container entrypoint: render then start Kong
├── Dockerfile                 # kong:3.7-ubuntu + python3; renders at startup
└── README.md                  # This file
```

## How it works

`build.sh` merges three sources at render time:

1. `config/kong.base.yml` — routes, plugins, and `{{PLACEHOLDER}}` tokens
2. `values/_defaults.yml` + `values/<env>.yml` — scalar values (hostnames, timeouts, rate limits)
3. `KONG_RSA_PUBLIC_KEY` env var — RSA public key (never stored in files)

The `{{JWT_SUB_LUA}}` placeholder is replaced by inlining `plugins/jwt-sub.lua` into every protected route's `post-function` block, eliminating the 12 duplicated copies that existed previously.

## Usage

### Docker Compose (local dev)

The `kong` service in `docker-compose.yml` builds this directory and runs `docker-entrypoint.sh` at startup. Set `KONG_RSA_PUBLIC_KEY` in your root `.env` file (copy from `.env.example`).

```bash
cp .env.example .env
# Fill in RSA_PRIVATE_KEY and KONG_RSA_PUBLIC_KEY
docker compose up --build
```

### minikube (local Kubernetes)

`infra/local/setup.sh` calls `build.sh minikube` automatically before `helm upgrade --install`, passing the rendered config via `--set-file kong.dblessConfig.config=<path>`.

```bash
cp infra/local/secrets.env.example infra/local/secrets.env
# Fill in RSA_PRIVATE_KEY, KONG_RSA_PUBLIC_KEY, STRIPE_SECRET_KEY
./infra/local/setup.sh
```

### Manual render + validate

```bash
export KONG_RSA_PUBLIC_KEY="$(cat /path/to/public.pem)"

# Render for a specific environment
./scripts/build.sh local              # writes services/kong-gateway/kong.yml
./scripts/build.sh minikube /tmp/k.yml  # writes to an explicit path

# Validate the rendered config (requires Docker)
./scripts/validate.sh /tmp/k.yml
```

## Configurable values

| Key | Default | Description |
|---|---|---|
| `HOST_AUTH` | `auth-service:3000` | auth-service upstream |
| `HOST_TICKETS` | `ticket-service:3001` | ticket-service upstream |
| `HOST_ORDERS` | `order-service:8082` | order-service upstream |
| `HOST_PAYMENTS` | `payment-service:3002` | payment-service upstream |
| `HOST_CLIENT` | `client:4000` | Next.js SSR upstream (catch-all) |
| `CONNECT_TIMEOUT_MS` | `5000` | Kong upstream connect timeout |
| `READ_TIMEOUT_MS` | `10000` | Kong upstream read timeout |
| `WRITE_TIMEOUT_MS` | `10000` | Kong upstream write timeout |
| `CLIENT_READ_TIMEOUT_MS` | `30000` | Read timeout for SSR client route |
| `CLIENT_WRITE_TIMEOUT_MS` | `30000` | Write timeout for SSR client route |
| `JWT_COOKIE_NAME` | `token` | Cookie name Kong reads the JWT from |
| `RATE_LIMIT_ANONYMOUS_PER_MINUTE` | `300` | Anonymous IP rate limit (requests/min) |
| `RATE_LIMIT_POLICY` | `local` | `local` (dev) or `redis` (staging/prod) |
| `HOST_MCP` | `mcp-service:3000` | mcp-service upstream (`/mcp`, protected-resource metadata) |
| `RATE_LIMIT_MCP_PER_MINUTE` | `600` | `/mcp` per-IP rate limit (requests/min) |
| `KONG_RSA_PUBLIC_KEY` | — | **Env var only.** RSA public key PEM. |
| `KONG_OAUTH_ISSUER` | `http://localhost:8000` (local, minikube only) | Public origin of the OAuth issuer (same as auth-service `OAUTH_ISSUER`). Keys the second `jwt_secret` and derives the REST audience `<origin>/api`. **Required for dev/staging/prod; the build fails without it.** Must be a bare origin, https outside local/minikube. |

The OAuth issuer must stay in step with auth-service: set `OAUTH_ISSUER_ENABLED=true` only for an
environment whose Kong was rendered with the matching `KONG_OAUTH_ISSUER` (compose and minikube do).

## Route summary

| Path | Methods | Auth |
|---|---|---|
| `/api/users/signup`, `/signin`, `/signout` | POST | Public |
| `/api/users/currentuser` | GET | JWT required |
| `/.well-known/jwks.json` | GET | Public |
| `/.well-known/oauth-protected-resource/mcp` | GET | Public (to mcp-service) |
| `/mcp` | POST, GET, DELETE | No Kong JWT; mcp-service verifies the `<origin>/mcp` token. Inbound `X-User-*` cleared, rate-limited per IP |
| `/api/tickets` | GET | Public |
| `/api/tickets/:id` | GET | Public |
| `/api/tickets`, `/api/tickets/:id` | POST, PUT, PATCH, DELETE | JWT required |
| `/api/orders`, `/api/orders/:id` | GET, POST, DELETE | JWT required |
| `/api/payments`, `/api/payments/:id` | GET, POST | JWT required |
| `/` (catch-all) | ALL | Public (Next.js SSR) |

## REST audience rule

`plugins/jwt-scope.lua` refuses (401 `token audience not accepted`) an OAuth token (one with `client_id`) whose `aud` does not contain `<KONG_OAUTH_ISSUER>/api`, so an MCP-audience token cannot be replayed on REST routes. Tokens without `aud` are tolerated for now (`aud` becomes mandatory later); browser tokens (no `client_id`) are unaffected.

This rule compares against `<KONG_OAUTH_ISSUER>/api` in every environment, including those where `OAUTH_ISSUER_ENABLED` is still false. `KONG_OAUTH_ISSUER` must therefore equal the origin auth-service derives `OAUTH_API_AUDIENCE` from (Helm `global.publicOrigin`). A mismatch 401s every OAuth REST call, including the existing first-party OAuth client.

`scripts/test-jwt-scope.sh` runs the real `jwt-scope.lua` under `resty` in a throwaway `kong:3.7-ubuntu` container and exercises the rule. It fails when docker is absent unless `KONG_TEST_SKIP_DOCKER=1` is set.

`scripts/test-build-lint.sh` asserts the routes that have no jwt plugin (and so escape the guard lint): `/mcp` and the protected-resource route.
