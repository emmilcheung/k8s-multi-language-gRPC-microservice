# ── Stage 1: build ───────────────────────────────────────────────────────────
# Use a Debian/Ubuntu-based Maven+Temurin image. Two reasons:
#   1. Maven is pre-installed — no apk-triggered java-common conflict that hangs builds.
#   2. glibc is present — protobuf-maven-plugin downloads glibc-linked protoc binaries
#      that cannot execute on Alpine's musl libc, causing MojoFailureException.
FROM maven:3.9.9-eclipse-temurin-21@sha256:3a4ab3276a087bf276f79cae96b1af04f53731bec53fb2e651aca79e4b10211e AS builder

WORKDIR /build

# Copy the shared proto files needed by the protobuf-maven-plugin
COPY proto/ /proto/

# Copy pom first so dependency layer is cached separately
COPY services/order-service/pom.xml .
# Download dependencies offline (layer cache friendly)
RUN mvn dependency:go-offline -q

# Download OpenTelemetry Java agent — zero-code auto-instrumentation (O-01).
# Pinned to v2.26.1. curl -fL follows GitHub's CDN redirect and fails loudly
# on non-2xx responses, unlike Docker ADD which silently writes empty files.
ARG OTEL_AGENT_VERSION=2.26.1
RUN curl -fL -o /build/otel-agent.jar \
    "https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v${OTEL_AGENT_VERSION}/opentelemetry-javaagent.jar"

# Copy source and build — skip tests (run separately in CI)
COPY services/order-service/src/ src/
RUN mvn package -DskipTests -q

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-alpine@sha256:6ad8ed080d9be96b61438ec3ce99388e294af216ed57356000c06070e85c5d5d AS runtime

# Non-root user (AGENTS.md §10.1)
RUN apk upgrade --no-cache && addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder /build/otel-agent.jar /app/otel-agent.jar

COPY --from=builder /build/target/order-service-*.jar app.jar

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health/liveness || exit 1

# OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME are injected as env vars at runtime.
# When OTEL_EXPORTER_OTLP_ENDPOINT is unset the agent runs in no-op mode.
ENTRYPOINT ["java", \
  "-Djava.security.egd=file:/dev/./urandom", \
  "-javaagent:/app/otel-agent.jar", \
  "-jar", "app.jar"]
