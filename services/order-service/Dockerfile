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

# Copy source and build — skip tests (run separately in CI)
COPY services/order-service/src/ src/
RUN mvn package -DskipTests -q

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-alpine@sha256:6ad8ed080d9be96b61438ec3ce99388e294af216ed57356000c06070e85c5d5d AS runtime

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
