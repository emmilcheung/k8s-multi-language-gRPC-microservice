#!/usr/bin/env bash
# services/kong-gateway/scripts/test-build-lint.sh
#
# Negative test for build.sh's OAuth-guard lint: a jwt route whose guard is the
# SECOND post-function access entry must fail the build. Works on a temp copy of
# the gateway dir, so the real config is never touched.
#
# Usage: ./scripts/test-build-lint.sh

set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
cp -R "${GATEWAY_DIR}/config" "${GATEWAY_DIR}/plugins" "${GATEWAY_DIR}/values" "${GATEWAY_DIR}/scripts" "${WORK}/"

# Swap the two access entries of the first scope-guarded route so the guard is second.
python3 - "${WORK}/config/kong.base.yml" <<'PYEOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
pat = re.compile(r'(\n( *)- \|\n *\{\{SCOPE_CHECK_LUA:[^}]+\}\})(\n *- \|\n *\{\{JWT_SUB_LUA\}\})')
m = pat.search(s)
if not m:
    sys.exit('fixture setup failed: no scope-guard-then-jwt-sub route found')
s = s[:m.start()] + m.group(3) + m.group(1) + s[m.end():]
open(p, 'w').write(s)
PYEOF

# A throwaway placeholder is enough: the lint runs before the key is used.
export KONG_RSA_PUBLIC_KEY="lint-test-placeholder"
if out="$("${WORK}/scripts/build.sh" local "${WORK}/out.yml" 2>&1)"; then
  echo "FAIL: build.sh accepted a route with the OAuth guard as the second entry" >&2
  exit 1
fi
if ! grep -q "FIRST entry" <<<"${out}"; then
  echo "FAIL: build.sh failed, but not with the guard-first lint error:" >&2
  echo "${out}" >&2
  exit 1
fi
echo "PASS: build.sh rejects a route whose OAuth guard is not the first entry"
