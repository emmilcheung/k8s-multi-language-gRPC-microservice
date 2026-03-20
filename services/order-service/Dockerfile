# ── Stage 1: copy pre-built JAR ──────────────────────────────────────────────────────────
FROM alpine:latest AS jarcopier
COPY services/order-service/target/order-service-0.0.1-SNAPSHOT.jar /app.jar

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-alpine AS runtime

# Non-root user (AGENTS.md §10.1)
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=jarcopier /app.jar app.jar

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health/liveness || exit 1

ENTRYPOINT ["java", \
  "-Djava.security.egd=file:/dev/./urandom", \
  "-jar", "app.jar"]
