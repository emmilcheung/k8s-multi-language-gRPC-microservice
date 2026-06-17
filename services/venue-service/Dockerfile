# Stage 1: build — Debian (glibc) required by confluent-kafka-go vendored librdkafka
# Build context must be the repo root (not the service directory) because
# go.mod has a replace directive pointing to ../../libs/grpc-stubs/go.
FROM golang:1.25-bookworm@sha256:bbb255b0e131db500cf0520adc97441d2260cf629c7fa7e39e025ddf53995a24 AS builder

# Install build dependencies needed by confluent-kafka-go (CGO-based)
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the local replace dependency first so `go mod download` can resolve it.
# go.mod contains: replace github.com/org/ticketing/libs/grpc-stubs/go => ../../libs/grpc-stubs/go
# From WORKDIR /app/services/venue-service, ../../libs/grpc-stubs/go = /app/libs/grpc-stubs/go
COPY libs/grpc-stubs/go /app/libs/grpc-stubs/go

# Copy dependency manifests for layer caching (only invalidated on go.mod/go.sum changes).
COPY services/venue-service/go.mod services/venue-service/go.sum /app/services/venue-service/

WORKDIR /app/services/venue-service
RUN go mod download

# Copy service source and build
COPY services/venue-service /app/services/venue-service
RUN CGO_ENABLED=1 GOOS=linux go build -o /venue-service ./cmd/server

# Stage 2: runtime
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates wget openssl libssl3 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

WORKDIR /app
COPY --from=builder /venue-service ./venue-service

USER app
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3003/healthz/live || exit 1

CMD ["./venue-service"]
