#!/usr/bin/env bash
# services/kong-gateway/scripts/validate.sh
#
# Validates a rendered kong.yml using `kong config parse`.
# Requires Docker (uses the kong:3.7-ubuntu image — no local Kong install needed).
#
# Usage:
#   ./scripts/validate.sh [kong-yml-path]
#
#   [kong-yml-path]  : path to the rendered kong.yml to validate
#                      (default: services/kong-gateway/kong.yml)
#
# Typically called right after build.sh:
#   KONG_RSA_PUBLIC_KEY="..." ./scripts/build.sh local && ./scripts/validate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Resolve to absolute path — docker --volume does not support relative paths on Linux.
_raw="${1:-${GATEWAY_DIR}/kong.yml}"
KONG_YML="$(cd "$(dirname "${_raw}")" && pwd)/$(basename "${_raw}")"
KONG_IMAGE="kong:3.7-ubuntu"

if [[ ! -f "${KONG_YML}" ]]; then
  echo "ERROR: Kong config file not found: ${KONG_YML}" >&2
  echo "  Run build.sh first to generate a rendered kong.yml." >&2
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker is not installed or not in PATH." >&2
  exit 1
fi

echo "[validate.sh] Validating: ${KONG_YML}"
echo "[validate.sh] Using image: ${KONG_IMAGE}"

# Run as root inside the throwaway validation container.
# This is a parse-only step — no production Kong is started.
# Root is needed because:
#   1. Kong creates /usr/local/kong/logs at startup (requires write access)
#   2. The mounted file may be owned by the CI runner uid (root can read any file)
docker run --rm \
  --env KONG_DATABASE=off \
  --user root \
  --volume "${KONG_YML}:/tmp/kong.yml:ro" \
  "${KONG_IMAGE}" \
  kong config parse /tmp/kong.yml

echo "[validate.sh] Validation passed."
