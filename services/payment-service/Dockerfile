# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Install dependencies first (layer cached unless manifest changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --silent

# Copy source and compile
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
RUN pnpm build

# Prune devDependencies so only prod deps land in the runtime image
RUN pnpm prune --prod --silent

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS runtime

# Refresh OS packages; remove npm (not used at runtime — eliminates CVE-2026-33671/33672/33750).
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy only what is needed to run
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json

# Migration SQL files — read at runtime by drizzle-orm/migrator
COPY --from=builder --chown=app:app /app/migrations ./migrations

USER app

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/healthz/ready || exit 1

CMD ["sh", "-c", "node dist/migrate && NODE_OPTIONS='--require ./dist/tracing' node dist/main"]
