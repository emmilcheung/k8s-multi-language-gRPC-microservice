# Stage 1: build — Debian (glibc) required by confluent-kafka-go vendored librdkafka
FROM golang:1.26-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c AS builder

# Install build dependencies needed by confluent-kafka-go (CGO-based)
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first so Docker can cache the download layer (P-10).
# This layer is only invalidated when go.mod or go.sum change, not on every source edit.
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build
COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -o /expiration-service ./cmd/server

# Stage 2: runtime
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates wget openssl libssl3 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

WORKDIR /app
COPY --from=builder /expiration-service ./expiration-service

# Numeric UID: k8s runAsNonRoot cannot verify a non-numeric USER and refuses
# to start the container ("image has non-numeric user (app)"). 999:999 is the
# uid:gid that adduser assigned to app in this image.
USER 999:999
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz/live || exit 1

CMD ["./expiration-service"]
