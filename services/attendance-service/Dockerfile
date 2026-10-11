# Stage 1: build — Debian (glibc) required by confluent-kafka-go vendored librdkafka
# Build context must be the repo root so Dockerfile paths resolve correctly.
FROM golang:1.26-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c AS builder

RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the local replace dependency first so `go mod download` can resolve it.
# go.mod contains: replace github.com/org/ticketing/libs/grpc-stubs/go => ../../libs/grpc-stubs/go
# From WORKDIR /app/services/attendance-service, ../../libs/grpc-stubs/go = /app/libs/grpc-stubs/go
COPY libs/grpc-stubs/go /app/libs/grpc-stubs/go

# Copy dependency manifests for layer caching.
COPY services/attendance-service/go.mod services/attendance-service/go.sum /app/services/attendance-service/

WORKDIR /app/services/attendance-service
RUN go mod download

# Copy service source and build
COPY services/attendance-service /app/services/attendance-service
RUN CGO_ENABLED=1 GOOS=linux go build -o /attendance-service ./cmd/server

# Stage 2: runtime
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates wget openssl libssl3 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

WORKDIR /app
COPY --from=builder /attendance-service ./attendance-service

# Numeric UID: k8s runAsNonRoot cannot verify a non-numeric USER and refuses
# to start the container ("image has non-numeric user (app)"). 999:999 is the
# uid:gid that adduser assigned to app in this image.
USER 999:999
EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3007/healthz/live || exit 1

CMD ["./attendance-service"]
