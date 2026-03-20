# Stage 1: build
FROM golang:1.25.0-alpine@sha256:dadf982d8f5628e59bcf6f4c8bfe91b72d6ef5a01f9ee37ca5e5df7a7bff5e64 AS builder

# Install build dependencies needed by confluent-kafka-go (CGO-based)
RUN apk add --no-cache gcc musl-dev

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -o /expiration-service ./cmd/server

# Stage 2: runtime
FROM alpine:3.20 AS runtime

RUN apk add --no-cache ca-certificates librdkafka && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=builder /expiration-service ./expiration-service

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz/live || exit 1

CMD ["./expiration-service"]
