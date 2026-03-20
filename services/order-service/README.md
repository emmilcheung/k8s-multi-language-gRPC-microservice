# order-service

Manages the order lifecycle for the ticketing platform.

## Responsibilities

- Create, read, and cancel orders.
- Maintains a local replica of ticket data from `tickets.ticket.created` / `tickets.ticket.updated` Kafka events.
- Validates ticket availability via gRPC call to `ticket-service` before creating an order.
- Publishes `orders.order.created` and `orders.order.cancelled` events via the transactional outbox pattern.
- Responds to `expiration.order.expiration_complete` (cancels expired orders) and `payments.payment.captured` (marks orders complete).

## Tech stack

| Concern | Choice |
|---|---|
| Language | Java 21 |
| Framework | Spring Boot 3.4.x |
| Database | PostgreSQL (Flyway migrations) |
| Messaging | Apache Kafka |
| Internal RPC | gRPC client → ticket-service |
| Tests | JUnit 5 + Mockito (unit), Testcontainers (integration) |

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `8082` | HTTP | REST API + Actuator |

## Environment variables

See `.env.example` for all required variables with placeholder values.

| Variable | Description |
|---|---|
| `SPRING_DATASOURCE_URL` | PostgreSQL JDBC URL |
| `SPRING_DATASOURCE_USERNAME` | DB username |
| `SPRING_DATASOURCE_PASSWORD` | DB password |
| `KAFKA_BROKERS` | Comma-separated Kafka bootstrap servers |
| `TICKET_SERVICE_GRPC_HOST` | Host of ticket-service gRPC server |
| `TICKET_SERVICE_GRPC_PORT` | Port of ticket-service gRPC server (default `9090`) |
| `PORT` | HTTP listen port (default `8082`) |
| `ORDER_EXPIRATION_MINUTES` | Minutes until an order expires (default `15`) |

## Running locally

```bash
# Start dependencies
docker compose up -d postgres-orders kafka

# Copy env file
cp .env.example .env  # edit as needed

# Run
./mvnw spring-boot:run
```

## Running tests

```bash
# Unit tests only
./mvnw test

# Unit + integration tests (requires Docker for Testcontainers)
./mvnw verify
```

## API

All routes require the `X-User-Id` header (injected by Kong after JWT validation).

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/orders` | Create an order |
| `GET` | `/api/orders` | List current user's orders |
| `GET` | `/api/orders/{id}` | Get a single order |
| `DELETE` | `/api/orders/{id}` | Cancel an order |

### Health

| Path | Description |
|---|---|
| `GET /actuator/health/liveness` | Liveness probe |
| `GET /actuator/health/readiness` | Readiness probe |
| `GET /actuator/prometheus` | Prometheus metrics |

## Kafka topics

| Topic | Direction | Description |
|---|---|---|
| `orders.order.created` | produced | New order created |
| `orders.order.cancelled` | produced | Order cancelled (manual or expiration) |
| `tickets.ticket.created` | consumed | Seed local ticket replica |
| `tickets.ticket.updated` | consumed | Update local ticket replica |
| `expiration.order.expiration_complete` | consumed | Expire an order |
| `payments.payment.captured` | consumed | Complete an order |
