# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jdk-alpine AS builder

WORKDIR /build

# Copy the shared proto files needed by the protobuf-maven-plugin
COPY proto/ /proto/

# Copy Maven wrapper / pom first so dependency layer is cached separately
COPY services/order-service/pom.xml .
# Download dependencies offline (layer cache friendly)
RUN apk add --no-cache maven && \
    mvn dependency:go-offline -q

# Copy source and build — skip tests (run separately in CI)
COPY services/order-service/src/ src/
RUN mvn package -DskipTests -q

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-alpine AS runtime

# Non-root user (AGENTS.md §10.1)
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder /build/target/order-service-*.jar app.jar

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health/liveness || exit 1

ENTRYPOINT ["java", \
  "-Djava.security.egd=file:/dev/./urandom", \
  "-jar", "app.jar"]
