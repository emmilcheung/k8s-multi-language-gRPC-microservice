# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

# Install dependencies first (layer cached unless manifest changes)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --silent

# Copy source and compile
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
RUN pnpm build

# Prune devDependencies so only prod deps land in the runtime image
RUN pnpm prune --prod --silent

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 AS runtime

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy only what is needed to run
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json

# Migrations are applied externally (init container / CI step) — ship the SQL files
COPY --chown=app:app migrations/ ./migrations/

USER app

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/healthz/live || exit 1

CMD ["node", "dist/main"]
