# Stage 1: build — Debian (glibc) required by confluent-kafka-go vendored librdkafka
FROM golang:1.25-bookworm@sha256:bbb255b0e131db500cf0520adc97441d2260cf629c7fa7e39e025ddf53995a24 AS builder

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
FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716 AS runtime

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates wget openssl libssl3 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

WORKDIR /app
COPY --from=builder /expiration-service ./expiration-service

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz/live || exit 1

CMD ["./expiration-service"]
