# syntax=docker/dockerfile:1

# Build context is the repo root (not the service directory): the image ships
# proto/accounts/v1/accounts.proto, which lives outside the service.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /app

RUN corepack enable

COPY services/user-service/package.json services/user-service/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --silent

COPY services/user-service/tsconfig*.json services/user-service/nest-cli.json ./
COPY services/user-service/src/ ./src/
COPY services/user-service/migrations/ ./migrations/
RUN pnpm build

RUN pnpm prune --prod --silent

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/migrations ./migrations
# Found by walking up from dist/grpc, so it must sit next to dist/.
COPY --chown=app:app proto/accounts/v1/accounts.proto ./proto/accounts/v1/accounts.proto

# Numeric UID: k8s runAsNonRoot cannot verify a non-numeric USER and refuses
# to start the container ("image has non-numeric user (app)"). 100:101 is the
# uid:gid that adduser -S assigned to app in this image.
USER 100:101

EXPOSE 3004 50053

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3004/healthz/ready || exit 1

CMD ["sh", "-c", "node dist/migrate && node dist/main"]
