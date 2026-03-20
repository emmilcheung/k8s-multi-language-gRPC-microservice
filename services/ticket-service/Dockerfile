# Stage 1: build
FROM golang:1.23.5-alpine@sha256:53443fdc64453f971b5c82374d86945b90c053880131b13ee50704001e77f23a AS builder

# Install build dependencies needed by confluent-kafka-go (CGO-based)
RUN apk add --no-cache gcc musl-dev

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 GOOS=linux go build -o /ticket-service ./cmd/server

# Stage 2: runtime
FROM alpine:3.20 AS runtime

RUN apk add --no-cache ca-certificates librdkafka && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=builder /ticket-service ./ticket-service

USER app
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/healthz/live || exit 1

CMD ["./ticket-service"]
