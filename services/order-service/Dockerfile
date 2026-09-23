# ── Stage 1: build ───────────────────────────────────────────────────────────
# Use a Debian/Ubuntu-based Maven+Temurin image. Two reasons:
#   1. Maven is pre-installed — no apk-triggered java-common conflict that hangs builds.
#   2. glibc is present — protobuf-maven-plugin downloads glibc-linked protoc binaries
#      that cannot execute on Alpine's musl libc, causing MojoFailureException.
FROM maven:3.9.15-eclipse-temurin-26@sha256:029a8e2838ae68238ffb8be407cddbb3f07d4d839c60c6f26c619a69fd184531 AS builder

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
# CVE-2026-54704: JDBC auto-instrumentation could leak double-quoted passwords
# from SQL CONNECT statements into trace spans prior to 2.28.0.
ARG OTEL_AGENT_VERSION=2.28.0
RUN curl -fL -o /build/otel-agent.jar \
    "https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v${OTEL_AGENT_VERSION}/opentelemetry-javaagent.jar"

# Copy source and build — skip tests (run separately in CI)
COPY services/order-service/src/ src/
RUN mvn package -DskipTests -q

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM eclipse-temurin:25-jre-alpine@sha256:2ca9adf44f5c29d28ecd26cf92d75cc0c66b7f32bfd839a4439e363a8b428af8 AS runtime

# Non-root user (AGENTS.md §10.1)
RUN apk upgrade --no-cache && addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=builder /build/otel-agent.jar /app/otel-agent.jar

COPY --from=builder /build/target/order-service-*.jar app.jar

# Numeric UID: k8s runAsNonRoot cannot verify a non-numeric USER and refuses
# to start the container ("image has non-numeric user (app)"). 100:101 is the
# uid:gid that adduser -S assigned to app in this image.
USER 100:101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health/liveness || exit 1

# OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_SERVICE_NAME are injected as env vars at runtime.
# When OTEL_EXPORTER_OTLP_ENDPOINT is unset the agent runs in no-op mode.
ENTRYPOINT ["java", \
  "-Djava.security.egd=file:/dev/./urandom", \
  "-javaagent:/app/otel-agent.jar", \
  "-jar", "app.jar"]
