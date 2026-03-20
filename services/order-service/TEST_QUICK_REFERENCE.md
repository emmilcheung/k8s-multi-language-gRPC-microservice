# Order Service — Test Quick Reference

## Run Tests Locally

### Unit Tests Only
```bash
cd services/order-service
mvn test
```
**Result**: 13 tests in ~3.5s

### Full Test Suite (Unit + Integration)
```bash
cd services/order-service
mvn verify
```
**Result**: 22 tests in ~13.7s

### Build JAR
```bash
cd services/order-service
mvn clean package -DskipTests
```
**Output**: `target/order-service-0.0.1-SNAPSHOT.jar` (96 MB)

### Build Docker Image
```bash
docker build -t order-service:test -f services/order-service/Dockerfile .
```
**Output**: `order-service:test` (308 MB)

### Run Application Locally
```bash
# 1. Start dependencies
docker compose up -d postgres-orders kafka

# 2. Copy and edit .env
cp .env.example .env

# 3. Run application
java -jar target/order-service-0.0.1-SNAPSHOT.jar

# 4. Check health
curl http://localhost:8080/actuator/health/liveness
```

---

## Test Files

| File | Purpose | Tests |
|------|---------|-------|
| `src/test/java/com/ticketing/orders/service/OrderServiceTest.java` | Unit tests for OrderService | 13 |
| `src/test/java/com/ticketing/orders/integration/OrderIntegrationTest.java` | Full-stack integration tests | 9 |

---

## API Endpoints (for manual testing)

### Create Order
```bash
curl -X POST http://localhost:8080/api/orders \
  -H "Content-Type: application/json" \
  -H "X-User-Id: user-uuid-here" \
  -d '{ "ticketId": "ticket-uuid-here" }'
```
**Response**: 201 Created

### List Orders
```bash
curl http://localhost:8080/api/orders \
  -H "X-User-Id: user-uuid-here"
```
**Response**: 200 OK with order array

### Get Single Order
```bash
curl http://localhost:8080/api/orders/order-uuid-here \
  -H "X-User-Id: user-uuid-here"
```
**Response**: 200 OK or 404 Not Found

### Cancel Order
```bash
curl -X DELETE http://localhost:8080/api/orders/order-uuid-here \
  -H "X-User-Id: user-uuid-here"
```
**Response**: 204 No Content or 404 Not Found

---

## Health Checks

### Liveness
```bash
curl http://localhost:8080/actuator/health/liveness
# { "status": "UP" }
```

### Readiness
```bash
curl http://localhost:8080/actuator/health/readiness
# { "status": "UP", "components": { "db": { "status": "UP" }, ... } }
```

### Metrics
```bash
curl http://localhost:8080/actuator/prometheus
# Prometheus format metrics
```

---

## Environment Variables

| Variable | Required | Default | Example |
|----------|----------|---------|---------|
| `SPRING_DATASOURCE_URL` | Yes in prod | — | `jdbc:postgresql://localhost:5432/orders` |
| `SPRING_DATASOURCE_USERNAME` | Yes in prod | — | `orders_user` |
| `SPRING_DATASOURCE_PASSWORD` | Yes in prod | — | `changeme` |
| `KAFKA_BROKERS` | Yes in prod | — | `localhost:9092` |
| `TICKET_SERVICE_GRPC_HOST` | No | `localhost` | `ticket-service.default.svc.cluster.local` |
| `TICKET_SERVICE_GRPC_PORT` | No | `9090` | `9090` |
| `PORT` | No | `8080` | `8080` |
| `ORDER_EXPIRATION_MINUTES` | No | `15` | `15` |

---

## Kafka Topics (Consumed)

| Topic | Purpose |
|-------|---------|
| `tickets.ticket.created` | Seed local ticket replica |
| `tickets.ticket.updated` | Update ticket replica (price, title) |
| `expiration.order.expiration_complete` | Expire pending orders |
| `payments.payment.captured` | Mark orders complete |

## Kafka Topics (Produced)

| Topic | Event | When |
|-------|-------|------|
| `orders.order.created` | Order created | User creates new order |
| `orders.order.cancelled` | Order cancelled | User cancels or order expires |

---

## Docker Image

### Image Details
- **Name**: `order-service:test` (locally) → `order-service:v1.0.0` (production)
- **Size**: 308 MB
- **Base**: `eclipse-temurin:21-jre-alpine`
- **Port**: 8080
- **User**: `app` (non-root)

### Health Check
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health/liveness || exit 1
```

### Run Container
```bash
docker run -d \
  --name order-service \
  -p 8080:8080 \
  -e SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/orders \
  -e SPRING_DATASOURCE_USERNAME=orders_user \
  -e SPRING_DATASOURCE_PASSWORD=changeme \
  -e KAFKA_BROKERS=kafka:9092 \
  -e TICKET_SERVICE_GRPC_HOST=ticket-service \
  order-service:test
```

---

## Test Statistics

| Metric | Value |
|--------|-------|
| Total Tests | 22 |
| Unit Tests | 13 |
| Integration Tests | 9 |
| Pass Rate | 100% |
| Failure Rate | 0% |
| Execution Time | 13.7s |
| Code Coverage | Good (critical paths) |

---

## Troubleshooting

### PostgreSQL Connection Failed
```
Error: org.postgresql.util.PSQLException: Connection to localhost:5432 refused
```
**Solution**: Start Docker: `docker compose up -d postgres-orders`

### Kafka Connection Failed
```
Error: [Consumer] Connection to node 1 could not be established
```
**Solution**: Start Kafka: `docker compose up -d kafka`

### gRPC Client Cannot Connect
```
Error: io.grpc.StatusRuntimeException: UNAVAILABLE
```
**Solution**: Ensure `ticket-service` is running on configured host:port

### Port Already In Use
```
Error: Address already in use: 8080
```
**Solution**: Change port with `-DPORT=8081` or kill existing process

### Database Migration Failed
```
Error: org.flywaydb.core.internal.command.DbMigrate: Unable to execute migration
```
**Solution**: Check `src/main/resources/db/migration/V1__init.sql` syntax

---

## CI/CD Pipeline Commands

### Lint & Format
```bash
cd services/order-service
mvn checkstyle:check
```

### Code Coverage Report
```bash
cd services/order-service
mvn verify jacoco:report
# Report: target/site/jacoco/index.html
```

### Build & Push Docker Image (CI)
```bash
VERSION=$(git rev-parse --short HEAD)
docker build -t order-service:${VERSION} -f services/order-service/Dockerfile .
docker push registry.example.com/order-service:${VERSION}
```

---

## Performance Notes

- **Startup Time**: ~5-10 seconds (includes DB migration, Kafka connection)
- **API Latency**: ~50-150ms (depends on DB + gRPC calls)
- **Memory**: ~500-800 MB JVM heap (adjust with `-Xmx1024m`)
- **CPU**: 1 core typical, spike to 2 cores on high load

---

## Standards Compliance

✅ AGENTS.md §2 — REST API design  
✅ AGENTS.md §3 — Kafka messaging (transactional outbox)  
✅ AGENTS.md §4 — PostgreSQL conventions  
✅ AGENTS.md §7 — Observability (logging, metrics, health checks)  
✅ AGENTS.md §8 — Error handling  
✅ AGENTS.md §10 — Docker containerization  
✅ AGENTS.md §13 — Testing standards  

---

## Documentation

- **Service README**: `README.md`
- **Test Plan**: `TEST_PLAN.md` (this directory)
- **Execution Log**: `TEST_EXECUTION_LOG.md` (this directory)
- **API Spec**: OpenAPI/Swagger (auto-generated from Spring Boot)
- **Proto Definitions**: `../../proto/orders/` (gRPC contracts)

---

## Support & Issues

For test failures or issues:
1. Check `TEST_EXECUTION_LOG.md` for known issues
2. Review application logs: `docker logs order-service`
3. Check database: `docker exec postgres-orders psql -U orders_user -d orders`
4. Check Kafka: `docker exec kafka kafka-topics --list --bootstrap-server localhost:9092`

---

*Last Updated: 2026-03-20*
