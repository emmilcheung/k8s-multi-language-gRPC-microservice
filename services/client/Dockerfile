# syntax=docker/dockerfile:1
# ─── Stage 1: dependencies ─────────────────────────────────────────────────────
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS deps
RUN npm install -g pnpm@10.32.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# ─── Stage 2: build ────────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS builder
RUN npm install -g pnpm@10.32.1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ─── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS runtime
# Refresh OS packages; remove npm (not used at runtime — eliminates CVE-2026-33671/33672/33750).
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Copy only the standalone output and static assets
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public
USER app
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/healthz/live || exit 1
CMD ["node", "server.js"]
