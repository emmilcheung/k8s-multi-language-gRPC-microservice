# Containerisation (Docker)

## Dockerfile Standards

```dockerfile
# Stage 1: build
FROM <lang>:<pinned-version>-alpine AS builder
WORKDIR /app
COPY <manifest-files> .
RUN <install-deps>          # only prod deps in final stage
COPY src/ ./src/
RUN <build-command>

# Stage 2: runtime
FROM <lang>:<pinned-version>-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder /app/dist ./dist
USER app                    # never run as root
EXPOSE <port>
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:<port>/healthz/live || exit 1
CMD ["<entrypoint>"]
```

Guidelines:

- **Always use multi-stage builds** — keep build tools out of the runtime image.
- **Never run as root** — create and use a dedicated non-root user.
- **Pin image versions to digest** in production: `FROM node:22.2.0-alpine@sha256:...`.
- **No secrets in images** — pass via env vars at runtime, not baked in.
- `.dockerignore` must exclude: `node_modules/`, `*.test.*`, `.env`, `.git`, CI config, docs.

## Image Size

- Prefer Alpine or distroless base images.
- Remove build artefacts and package manager caches in the same `RUN` layer they are created.
- Scan images with `trivy` or `grype` in CI.
