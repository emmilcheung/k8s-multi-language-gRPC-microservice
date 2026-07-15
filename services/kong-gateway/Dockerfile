# services/kong-gateway/Dockerfile
#
# Builds the Kong gateway container for Docker Compose (local dev) and CI.
# The stock kong:3.7-ubuntu image is used as the runtime — we never modify it.
# At container startup, build.sh renders kong.yml from env vars, then Kong starts.
#
# Environment variables required at runtime:
#   KONG_ENV               : target environment (local | minikube | dev | staging | prod)
#   KONG_RSA_PUBLIC_KEY    : RSA public key PEM contents (multi-line, injected at runtime)
#
# Kong configuration env vars (passed through to Kong itself):
#   KONG_DATABASE, KONG_DECLARATIVE_CONFIG, KONG_PROXY_LISTEN, etc.
#
# The rendered kong.yml is written to /etc/kong/kong.yml inside the container,
# which matches the KONG_DECLARATIVE_CONFIG path set in docker-compose.yml.

FROM kong:3.9-ubuntu@sha256:62721edc9669e2a96fe9d188ab8950b9105e69abb033129624a72d3e10da6777

# Install Python3 (used by build.sh for template rendering).
# kong:3.7-ubuntu is Debian-based; python3 is not included by default.
# Install in a single layer and clean up to keep the image lean.
USER root
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy gateway source into the image
COPY config/     /kong-gateway/config/
COPY plugins/    /kong-gateway/plugins/
COPY values/     /kong-gateway/values/
COPY scripts/    /kong-gateway/scripts/

RUN chmod +x /kong-gateway/scripts/build.sh /kong-gateway/scripts/validate.sh

# Entrypoint: render kong.yml from env vars, then hand off to the stock Kong entrypoint.
# KONG_ENV defaults to "local" for Docker Compose convenience.
COPY scripts/docker-entrypoint.sh /docker-entrypoint-kong-gw.sh
RUN chmod +x /docker-entrypoint-kong-gw.sh

# Pre-create /etc/kong with kong:kong ownership so the entrypoint render script
# can write the rendered config without running as root at runtime.
# The kong user/group are provided by the upstream kong:3.7-ubuntu base image.
RUN mkdir -p /etc/kong && chown kong:kong /etc/kong

# Switch to the non-root kong user before the entrypoint runs.
# AGENTS.md §10.1: "Never run as root."
USER kong

ENTRYPOINT ["/docker-entrypoint-kong-gw.sh"]
