# apollo-router — Agent Guidelines

> Service-specific notes; defers to root [`/AGENTS.md`](../../AGENTS.md) on conflict.

## Service Identity

- **Role:** GraphQL Federation gateway — composes a single supergraph from per-service subgraphs and routes GraphQL operations to the owning service.
- **Stack:** Apollo Router (Rust), distributed as the upstream image `ghcr.io/apollographql/router:v2.1.1`. No application code is built in this directory; configuration only.
- **Ports:** `4001` (GraphQL endpoint, exposed on host); `8088` internal admin/health port (used by container healthcheck).
- **Datastore:** none (stateless router).

## Quick Commands

This service ships as a config-only directory consumed by the upstream Apollo Router image. There is no language toolchain to install.

```bash
# build (compose builds nothing; the image is pulled)
docker compose pull apollo-router

# run locally via docker compose (from repo root)
docker compose up apollo-router

# regenerate the supergraph schema from supergraph-config.yaml
# (requires `rover` CLI)
./scripts/compose.sh

# validate router config syntax
docker run --rm -v "$PWD:/dist/config" ghcr.io/apollographql/router:v2.1.1 \
  --config /dist/config/router.yaml --schema /dist/config/supergraph.graphql --check
```

## Project Layout

```
Dockerfile                 ← thin wrapper (image is mostly the upstream router)
router.yaml                ← runtime config: listen address, CORS, telemetry, plugins
supergraph-config.yaml     ← rover compose input: lists subgraphs and their SDL/URLs
supergraph.graphql         ← composed supergraph schema (generated artifact, committed)
scripts/                   ← compose / validation helpers invoked by docker entrypoint
```

## Cross-Service Interactions

- **Federates** subgraphs from backend services (ticket-service, order-service, user-service, etc.) over HTTP — see `supergraph-config.yaml` for the authoritative subgraph list and routing URLs.
- **Upstream of:** Kong API Gateway (Kong proxies `/graphql` to apollo-router on `:4001`).
- **Telemetry:** exports OTLP traces to `otel-collector:4317` (`OTEL_SERVICE_NAME=apollo-router`).

## Notes

- The supergraph schema is a **generated artifact** — regenerate it via the rover compose flow whenever a subgraph SDL changes; do not hand-edit `supergraph.graphql`.
- `APOLLO_SANDBOX_ENABLED=true` in dev exposes the in-browser Sandbox at `http://localhost:4001/`. Disable in staging/prod.
- Healthcheck hits the admin port (`8088`), not the GraphQL port — keep both listeners enabled in `router.yaml`.

For platform-wide standards (testing, security, observability, hard stops), see root [`/AGENTS.md`](../../AGENTS.md) TOC.
