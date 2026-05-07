# Stage 1: build — Debian (glibc) required by confluent-kafka-go vendored librdkafka
# Build context must be the repo root so Dockerfile paths resolve correctly.
FROM golang:1.25-bookworm@sha256:29e59af995c51a5bf63d072eca973b918e0e7af4db0e4667aa73f1b8da1a6d8c AS builder

RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests for layer caching.
COPY services/attendance-service/go.mod services/attendance-service/go.sum /app/services/attendance-service/

WORKDIR /app/services/attendance-service
RUN go mod download

# Copy service source and build
COPY services/attendance-service /app/services/attendance-service
RUN CGO_ENABLED=1 GOOS=linux go build -o /attendance-service ./cmd/server

# Stage 2: runtime
FROM debian:bookworm-slim@sha256:4724b8cc51e33e398f0e2e15e18d5ec2851ff0c2280647e1310bc1642182655d AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget openssl libssl3 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

WORKDIR /app
COPY --from=builder /attendance-service ./attendance-service

USER app
EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3007/healthz/live || exit 1

CMD ["./attendance-service"]
