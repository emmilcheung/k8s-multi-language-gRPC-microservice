# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00 AS builder

WORKDIR /app

# Install dependencies first (layer cached unless manifest changes)
COPY package*.json ./
RUN npm ci --silent

# Copy source and compile
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

# Prune devDependencies so only prod deps land in the runtime image
RUN npm prune --omit=dev --silent

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00 AS runtime

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

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz/live || exit 1

CMD ["node", "dist/main"]
