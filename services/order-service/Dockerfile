# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /app

# Copy Maven wrapper and POM first — allows Docker to cache the dependency layer
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./

# Download dependencies (offline-friendly layer cache)
RUN ./mvnw dependency:go-offline -q

# Copy proto sources (relative path from build context = services/order-service)
COPY ../../proto /proto

# Copy application sources
COPY src ./src

# Build — skip tests (tests run in CI, not during image build)
RUN ./mvnw package -DskipTests -q

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-alpine AS runtime

# Non-root user (AGENTS.md §10.1)
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=builder /app/target/order-service-*.jar app.jar

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health/liveness || exit 1

ENTRYPOINT ["java", \
  "-Djava.security.egd=file:/dev/./urandom", \
  "-jar", "app.jar"]
