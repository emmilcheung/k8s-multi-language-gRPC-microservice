# order-service — Agent Guidelines

> **Source of truth:** [`/AGENTS.md`](../../AGENTS.md) at the monorepo root.
> These notes extend and specialise the root guidelines for this service.
> When anything here conflicts with the root, the **root wins**.

---

## Service Identity

| Field | Value |
|---|---|
| **Role** | Order lifecycle management — creates orders, coordinates with ticket and payment services, enforces expiration |
| **Language** | Java 21 |
| **Framework** | Spring Boot 3.4.x |
| **Build tool** | Maven |
| **Test runner** | JUnit 5 + Testcontainers |
| **Database** | PostgreSQL via Spring Data JPA / Hibernate; schema managed by Flyway |
| **Messaging** | Kafka consumer + producer (`spring-kafka`) |
| **gRPC** | Client — calls `ticket-service` `TicketService` (Netty, `grpc-netty-shaded 1.68.x`) |
| **Pattern** | Transactional outbox |
| **HTTP port** | 8082 |

---

## Quick Commands

```bash
# Compile
mvn -q compile

# Run unit tests
mvn -q test

# Run integration tests (requires Docker for Testcontainers)
mvn -q verify -Pfailsafe

# Lint / style check (must pass before push)
mvn -q checkstyle:check

# Build fat JAR
mvn -q package -DskipTests

# Run locally
java -jar target/order-service-*.jar
```

---

## Project Layout

```
src/
  main/
    java/com/ticketing/orders/
      OrderServiceApplication.java   ← main; validates config at startup
      config/                        ← Spring @Configuration classes (Kafka, gRPC client, etc.)
      controller/                    ← @RestController — thin, delegates to service layer
      dto/                           ← request/response DTOs (Bean Validation annotations)
      entity/                        ← JPA @Entity classes
      event/                         ← Kafka event envelope POJOs (CloudEvents)
      exception/                     ← @ControllerAdvice global handler + custom exceptions
      grpc/                          ← gRPC client wrappers (calls ticket-service)
      kafka/                         ← Kafka consumer + producer
      outbox/                        ← Transactional outbox table entity + relay scheduler
      repository/                    ← Spring Data JPA repositories
      service/                       ← Business logic
    resources/
      application.yml                ← config (properties loaded from env vars)
      db/migration/                  ← Flyway SQL migration files (append-only)
  test/
    java/com/ticketing/orders/       ← JUnit 5 unit + integration tests
```

---

## Spring Boot Conventions

- **Fail loudly at startup.** Use `@Value` with no default, or a `@ConfigurationProperties` class with `@Validated`, so Spring refuses to start when required properties are absent.
- **Controllers are thin** — delegate entirely to the `@Service` layer. No business logic in `@RestController`.
- **Service layer orchestrates; repositories access data.** Do not call a repository directly from a controller.
- **Bean Validation on all DTOs.** Use `@Valid` on `@RequestBody` parameters. Annotate DTO fields with `@NotNull`, `@NotBlank`, `@Size`, `@Pattern`, etc. Unknown fields are rejected by Jackson `DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES = true` (set globally in config).
- **`@ControllerAdvice`** handles exceptions globally and maps them to the canonical error response format (see [§03 API Design](../../docs/03-api-design.md)).
- Use constructor injection (`@RequiredArgsConstructor` or explicit constructor) — avoid field injection with `@Autowired`.
- **Immutable DTOs preferred**: use Java records or Lombok `@Value` for response DTOs.

---

## gRPC — Client Rules (calls ticket-service)

> Full API design guide: [`docs/03-api-design.md`](../../docs/03-api-design.md)

- Generated stubs are in [`/libs/grpc-stubs/`](../../libs/grpc-stubs/) — **never hand-edit them**; regenerate with `make proto` at repo root.
- The gRPC client bean is configured in `config/`, injected into `grpc/` wrappers.
- **Always set explicit deadlines** on every stub call: 5 s for reads, 10 s for writes.
- Handle gRPC `StatusRuntimeException` and map to appropriate HTTP responses in `@ControllerAdvice`:
  - `NOT_FOUND` → 404
  - `INVALID_ARGUMENT` → 400
  - `UNAVAILABLE` → 503 (trigger circuit breaker)
- **Circuit breaker** around the gRPC client (Resilience4j): open at 50% errors over 10 s; fallback required (e.g. return 503 with retry hint).

---

## Kafka — Consumer & Producer Rules

> Full messaging guide: [`docs/04-asynchronous-messaging.md`](../../docs/04-asynchronous-messaging.md)

### Consumer

- Consumes: `payments.payment.captured`, `expiration.order.expired` (and any other domain events that affect the order lifecycle).
- Consumer group: `order-service`.
- **Idempotent handlers** — the same message may arrive more than once. Check for existing state before processing.
- Commit offsets after successful processing.
- On failure: retry with back-off (Spring Kafka `RetryTemplate`), then route to DLT. Never silently discard.

### Producer (via transactional outbox)

- **Do not produce to Kafka directly inside a `@Transactional` method.** Instead, write to the `outbox` table in the same transaction; a `@Scheduled` relay reads and publishes.
- Topics produced: `orders.order.created`, `orders.order.cancelled`.
- Partition key = `orderId`.
- Producer: `acks=all`, `enable.idempotence=true`.
- CloudEvents v1.0 envelope on every message.

---

## Database — JPA / Flyway Rules

> Full data guide: [`docs/05-data-conventions.md`](../../docs/05-data-conventions.md)

- **Flyway migrations are append-only.** Files in `db/migration/` are immutable once merged to `main`. Use `V<N>__<description>.sql` naming.
- **Never alter the schema manually** or via Hibernate `hbm2ddl.auto=create/update` in production — set `validate` or `none`.
- **UUID primary keys** (`@GeneratedValue(strategy = GenerationType.UUID)` or custom generator).
- **Named constraints** on every FK, unique, and check constraint.
- `createdAt` / `updatedAt` on every entity, managed via JPA `@PrePersist` / `@PreUpdate` listeners.
- **Use `@Lock(LockModeType.PESSIMISTIC_WRITE)` or optimistic locking** (`@Version`) for concurrent order state updates.
- **JPQL: always project named fields.** Avoid `SELECT o FROM Order o` in bulk — name required attributes.
- **Index every FK** and every column in `WHERE` / `ORDER BY` clauses.

---

## Security

> Full security guide: [`docs/06-security.md`](../../docs/06-security.md)

- This service **never validates JWTs.** Kong validates upstream; `X-User-Id` and `X-User-Roles` are trusted forwarded headers read by a `HandlerInterceptor` or filter.
- **Ownership check before any write:** confirm `X-User-Id` owns the order before allowing cancellations or updates.
- Bean Validation rejects unknown/malformed fields; `FAIL_ON_UNKNOWN_PROPERTIES = true` in Jackson config.
- **JPQL/HQL parameterised queries only.** Never interpolate user input into query strings.
- **No PII or secrets in logs.** Configure Logback masking patterns for sensitive fields.
- `spring-boot-starter-actuator` endpoints must be restricted — expose only `/actuator/health` and `/actuator/prometheus` externally; gate all others behind a management port or internal-only network policy.

---

## Observability

> Full observability guide: [`docs/08-observability.md`](../../docs/08-observability.md)

- Structured JSON logging via `logstash-logback-encoder`. Every log entry must carry `traceId`, `spanId`, `service=order-service`.
- OpenTelemetry Java agent auto-instruments Spring Boot, JDBC, Kafka, and gRPC. Include the agent JAR in the Docker `CMD` or via `JAVA_TOOL_OPTIONS=-javaagent:/otel-agent.jar`.
- Prometheus metrics exposed at `/actuator/prometheus`.
- RED metrics collected automatically via OTel + micrometer bridge.
- Health: `GET /actuator/health/liveness` and `GET /actuator/health/readiness` (Spring Boot Actuator probes).

---

## Testing

> Full testing guide: [`docs/13-testing.md`](../../docs/13-testing.md)

- **Unit tests** (JUnit 5): use `@ExtendWith(MockitoExtension.class)`, mock repositories and gRPC stub. No spring context required for pure unit tests.
- **Integration tests** (`@SpringBootTest` + Testcontainers): spin up real PostgreSQL and Kafka using `@Container` fields. Use `@Transactional` or manual cleanup in `@AfterEach`.
- **gRPC stub testing:** use `InProcessServer` / `InProcessChannelBuilder` from `grpc-testing` to stub the ticket-service without network.
- Test naming: `methodName_shouldBehaviour_whenCondition` (JUnit 5 style).
- Run `mvn test` for unit tests; require Docker for `mvn verify`.

---

## Environment Variables / Application Properties

Spring Boot reads from `application.yml` which maps to env vars. Startup fails if required vars are absent.

| Env Variable | Purpose |
|---|---|
| `DB_URL` | PostgreSQL JDBC URL |
| `DB_USERNAME` | Database username |
| `DB_PASSWORD` | Database password |
| `KAFKA_BOOTSTRAP_SERVERS` | Kafka broker list |
| `TICKET_GRPC_HOST` | ticket-service gRPC host |
| `TICKET_GRPC_PORT` | ticket-service gRPC port |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTel Collector endpoint |
| `SPRING_PROFILES_ACTIVE` | Spring profile (`local`, `prod`) |

---

## Hard Stops (inherit from root)

See [§15 Agent Hard Stops](../../docs/15-agent-hard-stops.md). Key items for this service:

- Do **not** run Flyway migrations against a non-local database without explicit confirmation.
- Do **not** change `hbm2ddl.auto` to `create`, `create-drop`, or `update` in any non-test profile.
- Do **not** log or print `DB_PASSWORD` or any credential.
- Do **not** hand-edit files in `libs/grpc-stubs/` — regenerate with `make proto`.
- Do **not** add a new Maven dependency to `pom.xml` without noting it and explaining why.
