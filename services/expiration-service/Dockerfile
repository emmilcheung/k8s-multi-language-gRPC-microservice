# Stage 1: build — Debian (glibc) required by confluent-kafka-go vendored librdkafka
FROM golang:1.25-bookworm@sha256:7fb09d8804035fbde8a84ed59ca9f46dd68c6f160f9d193e98d795d8d9e002ec AS builder

# Install build dependencies needed by confluent-kafka-go (CGO-based)
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY go.mod go.sum ./
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o /expiration-service ./cmd/server

# Stage 2: runtime
FROM debian:bookworm-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app app

WORKDIR /app
COPY --from=builder /expiration-service ./expiration-service

USER app
EXPOSE 8083

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8083/healthz/live || exit 1

CMD ["./expiration-service"]
