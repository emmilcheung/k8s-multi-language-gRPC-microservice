# kong-gateway — Agent Guidelines

> Service-specific notes; defers to root [`/AGENTS.md`](../../AGENTS.md) on conflict.

## Service Identity

- **Role:** Public-edge API gateway — terminates client traffic, validates JWTs, enforces rate limits, and proxies to backend services. Multi-environment config via templated rendering.
- **Stack:** Kong 3.7 (DB-less / declarative) on the `kong:3.7-ubuntu` base, plus `python3` for templating. Custom Lua plugin for JWT `sub` extraction.
- **Ports:** `8000` (proxy, HTTP), `8443` (proxy, HTTPS), `8001` (admin, internal only). Confirm exact host bindings in repo-root `docker-compose.yml`.
- **Datastore:** none (DB-less mode — declarative `kong.yml` is the source of truth at boot).

## Quick Commands

```bash
# build (renders kong.yml from template + values + env, then starts Kong)
docker compose up --build kong

# render kong.yml for a specific environment
export KONG_RSA_PUBLIC_KEY="$(cat /path/to/public.pem)"
./scripts/build.sh local                # writes services/kong-gateway/kong.yml
./scripts/build.sh minikube /tmp/k.yml  # explicit output path

# validate a rendered kong.yml (requires Docker)
./scripts/validate.sh /tmp/k.yml

# lint: there is no language linter; validation = `kong config parse` via validate.sh
```

## Project Layout

```
config/
  kong.base.yml          ← template with {{PLACEHOLDER}} tokens (do not deploy directly)
plugins/
  jwt-sub.lua            ← single canonical post-function plugin: JWT sub → X-User-Id
values/
  _defaults.yml          ← defaults for all envs
  local.yml              ← Docker Compose overrides
  minikube.yml           ← local Kubernetes overrides
  dev.yml / staging.yml / prod.yml  ← EKS overrides per environment
scripts/
  build.sh               ← merges base + values + env into kong.yml
  validate.sh            ← runs `kong config parse` against a rendered file
  docker-entrypoint.sh   ← container entrypoint: render then exec kong
Dockerfile               ← kong:3.7-ubuntu + python3
```

## Cross-Service Interactions

- **Routes incoming HTTP** to: `auth-service:3000`, `ticket-service:3001`, `order-service:8082`, `payment-service:3002`, `client:4000` (catch-all SSR), and apollo-router for GraphQL.
- **Auth model:** JWT in cookie `token` (default name) → Kong JWT plugin validates RS256 signature using `KONG_RSA_PUBLIC_KEY` → `jwt-sub.lua` post-function copies `sub` claim to `X-User-Id` header for upstream services.
- **Rate limiting:** local policy in dev, Redis policy in staging/prod (`RATE_LIMIT_POLICY`).

## Notes

- `KONG_RSA_PUBLIC_KEY` is **env-var only** — never write the key into a file in this directory or commit a rendered `kong.yml` containing it.
- The `{{JWT_SUB_LUA}}` placeholder inlines `plugins/jwt-sub.lua` into every protected route's `post-function` block at render time — do not duplicate the Lua across routes manually.
- Helm/minikube path: `infra/local/setup.sh` calls `build.sh minikube` and passes the rendered config via `--set-file kong.dblessConfig.config=<path>`.
- Full route + value tables live in `README.md` — keep them in sync when adding routes.

For platform-wide standards (testing, security, observability, hard stops), see root [`/AGENTS.md`](../../AGENTS.md) TOC.
