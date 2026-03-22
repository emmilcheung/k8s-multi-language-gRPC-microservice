#!/usr/bin/env bash
# services/kong-gateway/scripts/docker-entrypoint.sh
#
# Container entrypoint for the kong-gateway image.
# 1. Renders /etc/kong/kong.yml via build.sh using runtime env vars.
# 2. Delegates to the stock Kong entrypoint to start Kong itself.
#
# Required env vars:
#   KONG_ENV             : local | minikube | dev | staging | prod  (default: local)
#   KONG_RSA_PUBLIC_KEY  : RSA public key PEM (multi-line)

set -euo pipefail

KONG_ENV="${KONG_ENV:-local}"
RENDERED_CONFIG="/etc/kong/kong.yml"

echo "[entrypoint] Rendering kong.yml for environment: ${KONG_ENV}"

/kong-gateway/scripts/build.sh "${KONG_ENV}" "${RENDERED_CONFIG}"

echo "[entrypoint] Kong config rendered. Starting Kong..."

# Hand off to the stock Kong Docker entrypoint.
# The upstream kong:3.7-ubuntu image uses this path.
exec /docker-entrypoint.sh kong docker-start
