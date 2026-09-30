# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:01743339035a5c3c11a373cd7c83aeab6ed1457b55da6a69e014a95ac4e4700b AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --silent

COPY tsconfig*.json ./
COPY src/ ./src/
RUN pnpm build

# Prune devDependencies so only prod deps land in the runtime image
RUN pnpm prune --prod --silent

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:01743339035a5c3c11a373cd7c83aeab6ed1457b55da6a69e014a95ac4e4700b AS runtime

# Refresh OS packages; remove npm (not used at runtime — eliminates its CVEs).
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json

# Numeric UID: k8s runAsNonRoot cannot verify a non-numeric USER and refuses
# to start the container. 100:101 is the uid:gid adduser -S assigned to app.
USER 100:101

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# --import is the ESM counterpart of auth-service's --require: OTel must load
# before the app so it can patch node:http.
CMD ["sh", "-c", "NODE_OPTIONS='--import ./dist/tracing.js' node dist/main.js"]
