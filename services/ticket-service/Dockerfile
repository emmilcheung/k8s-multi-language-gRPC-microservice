# Stage 1: build — Debian (glibc) required by confluent-kafka-go vendored librdkafka
# Build context must be the repo root (not the service directory) because
# go.mod has a replace directive pointing to ../../libs/grpc-stubs/go.
FROM golang:1.26-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651 AS builder

# Install build dependencies needed by confluent-kafka-go (CGO-based)
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the local replace dependency first so `go mod download` can resolve it.
# go.mod contains: replace github.com/org/ticketing/libs/grpc-stubs/go => ../../libs/grpc-stubs/go
# From WORKDIR /app/services/ticket-service, ../../libs/grpc-stubs/go = /app/libs/grpc-stubs/go
COPY libs/grpc-stubs/go /app/libs/grpc-stubs/go

# Copy dependency manifests for layer caching (only invalidated on go.mod/go.sum changes).
COPY services/ticket-service/go.mod services/ticket-service/go.sum /app/services/ticket-service/

WORKDIR /app/services/ticket-service
RUN go mod download

# Copy service source and build
COPY services/ticket-service /app/services/ticket-service
RUN CGO_ENABLED=1 GOOS=linux go build -o /ticket-service ./cmd/server

# Stage 2: runtime
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates wget openssl libssl3 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

WORKDIR /app
COPY --from=builder /ticket-service ./ticket-service

USER app
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/healthz/live || exit 1

CMD ["./ticket-service"]
