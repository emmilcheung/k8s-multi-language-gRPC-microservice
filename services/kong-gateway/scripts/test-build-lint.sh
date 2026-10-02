#!/usr/bin/env bash
# services/kong-gateway/scripts/test-build-lint.sh
#
# Negative tests for build.sh. Works on a temp copy of the gateway dir, so the
# real config is never touched.
#   1. OAuth-guard lint: a jwt route whose guard is the SECOND post-function
#      access entry must fail the build.
#   2. Queue secret: an armed gate outside local must refuse the committed dev
#      QUEUE_HMAC_SECRET (without printing it) and accept an injected one.
#   3. MCP routes (WS-K): the /mcp and protected-resource routes carry no jwt
#      plugin, so the guard lint cannot see them; assert them here. Also the
#      second jwt_secret and the REST audience rule, and that a missing issuer
#      fails the build instead of rendering a gateway that rejects every OAuth token.
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
# Every env renders the MCP routes, so every build needs the OAuth issuer origin (K-5).
export KONG_OAUTH_ISSUER="https://ticketing.example.com"
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

# ── Queue secret: the committed dev default must not arm a non-local gate ────
# Restore the real template (the fixture above swapped route entries), arm the
# gate in the temp staging values, and use a runtime-generated secret so no
# secret literal lives in this script.
cp "${GATEWAY_DIR}/config/kong.base.yml" "${WORK}/config/kong.base.yml"
printf '\nQUEUE_GATE_ARMED: "true"\n' >> "${WORK}/values/staging.yml"
printf '\nQUEUE_GATE_ARMED: "true"\n' >> "${WORK}/values/local.yml"
DEFAULT_SECRET="$(sed -n 's/^QUEUE_HMAC_SECRET:[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "${WORK}/values/_defaults.yml")"
if [[ -z "${DEFAULT_SECRET}" ]]; then
  echo "FAIL: fixture setup: could not read the QUEUE_HMAC_SECRET default" >&2
  exit 1
fi
INJECTED_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
export KONG_RATE_LIMIT_REDIS_HOST="redis.example.internal"
unset QUEUE_HMAC_SECRET

# staging + armed + default secret -> fail, naming the variable, never the value
if out="$("${WORK}/scripts/build.sh" staging "${WORK}/out.yml" 2>&1)"; then
  echo "FAIL: build.sh accepted an armed staging gate with the committed dev secret" >&2
  exit 1
fi
if ! grep -q "committed dev default" <<<"${out}"; then
  echo "FAIL: build.sh failed, but not with the queue secret error:" >&2
  echo "${out}" >&2
  exit 1
fi
if grep -qF -e "${DEFAULT_SECRET}" <<<"${out}"; then
  echo "FAIL: build.sh output leaked the queue secret" >&2
  exit 1
fi
echo "PASS: build.sh refuses the committed dev queue secret on an armed staging gate"

# staging + armed + injected secret -> pass, and the injected value is rendered
if ! out="$(QUEUE_HMAC_SECRET="${INJECTED_SECRET}" "${WORK}/scripts/build.sh" staging "${WORK}/out.yml" 2>&1)"; then
  echo "FAIL: build.sh rejected an armed staging gate with an injected secret:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! grep -qF -e "${INJECTED_SECRET}" "${WORK}/out.yml" || grep -qF -e "${DEFAULT_SECRET}" "${WORK}/out.yml"; then
  echo "FAIL: injected QUEUE_HMAC_SECRET did not override the values default" >&2
  exit 1
fi
echo "PASS: build.sh accepts an injected QUEUE_HMAC_SECRET on an armed staging gate"

# local + armed + default secret -> pass (dev default is fine for compose)
if ! out="$("${WORK}/scripts/build.sh" local "${WORK}/out.yml" 2>&1)"; then
  echo "FAIL: build.sh rejected an armed local gate with the dev secret:" >&2
  echo "${out}" >&2
  exit 1
fi
echo "PASS: build.sh allows the dev queue secret on an armed local gate"

# ── Unsafe secrets are rejected whatever the source, armed or not ────────────
# Values are built at runtime and never echoed; only the output is checked for a leak.
expect_unsafe_rejected() {  # <label> <secret> <marker-substring-to-check-for-leak>
  local label="$1" secret="$2" leak="$3"
  if out="$(QUEUE_HMAC_SECRET="${secret}" "${WORK}/scripts/build.sh" staging "${WORK}/out.yml" 2>&1)"; then
    echo "FAIL: build.sh accepted a QUEUE_HMAC_SECRET containing ${label}" >&2
    exit 1
  fi
  if ! grep -q "cannot be embedded safely" <<<"${out}" || ! grep -q "QUEUE_HMAC_SECRET" <<<"${out}"; then
    echo "FAIL: ${label}: build.sh failed, but not with the embeddable-secret error" >&2
    exit 1
  fi
  if grep -qF -e "${leak}" <<<"${out}"; then
    echo "FAIL: ${label}: build.sh output leaked the secret" >&2
    exit 1
  fi
  echo "PASS: build.sh rejects a QUEUE_HMAC_SECRET containing ${label}"
}
RAND="$(python3 -c 'import secrets; print(secrets.token_hex(12))')"
NL=$'\n'
# Disarmed staging on purpose: the check must not depend on the gate being armed.
sed -i.bak '/^QUEUE_GATE_ARMED:/d' "${WORK}/values/staging.yml" && rm -f "${WORK}/values/staging.yml.bak"
expect_unsafe_rejected 'a double quote' "${RAND}\"; error(\"x\") --" "${RAND}"
expect_unsafe_rejected 'a backslash' "${RAND}\\n${RAND}" "${RAND}"
expect_unsafe_rejected 'a newline' "${RAND}${NL}${RAND}" "${RAND}"
expect_unsafe_rejected 'a placeholder brace pair' "${RAND}{{${RAND}" "${RAND}"

# disarmed staging + committed default -> builds (nothing to forge without the gate)
if ! out="$("${WORK}/scripts/build.sh" staging "${WORK}/out.yml" 2>&1)"; then
  echo "FAIL: build.sh rejected disarmed staging with the default secret:" >&2
  echo "${out}" >&2
  exit 1
fi
echo "PASS: build.sh builds disarmed staging with the default queue secret"

# An empty env var must not clobber a values-file secret
printf '\nQUEUE_HMAC_SECRET: "%s"\n' "${INJECTED_SECRET}" >> "${WORK}/values/staging.yml"
if ! out="$(QUEUE_HMAC_SECRET="" "${WORK}/scripts/build.sh" staging "${WORK}/out.yml" 2>&1)"; then
  echo "FAIL: build.sh failed with an empty env secret and a values-file secret:" >&2
  echo "${out}" >&2
  exit 1
fi
if ! grep -qF -e "${INJECTED_SECRET}" "${WORK}/out.yml" || grep -qF -e "${DEFAULT_SECRET}" "${WORK}/out.yml"; then
  echo "FAIL: an empty QUEUE_HMAC_SECRET env var clobbered the values-file secret" >&2
  exit 1
fi
echo "PASS: an empty QUEUE_HMAC_SECRET env var does not clobber a values-file secret"

# ── WS-K: MCP routes, second jwt_secret, REST audience rule ──────────────────
# These routes have no jwt plugin, so the guard lint above ignores them by
# construction. Without these checks a refactor could silently put a jwt plugin
# (and its guard obligations) on /mcp, or drop the X-User-* clearing that stops
# a client spoofing identity to mcp-service.
unset QUEUE_HMAC_SECRET
sed -i.bak '/^QUEUE_GATE_ARMED:/d' "${WORK}/values/local.yml" && rm -f "${WORK}/values/local.yml.bak"
ISSUER="https://ticketing.example.com"
export KONG_OAUTH_ISSUER="${ISSUER}"
if ! out="$("${WORK}/scripts/build.sh" local "${WORK}/mcp.yml" 2>&1)"; then
  echo "FAIL: build.sh rejected local with an OAuth issuer:" >&2
  echo "${out}" >&2
  exit 1
fi

# route_block <rendered-file> <route-name>: print that route's YAML block
route_block() {
  python3 - "$1" "$2" <<'PYEOF'
import re, sys
text = open(sys.argv[1]).read()
for block in re.split(r'\n(?=      - name: )', text):
    if block.lstrip().startswith('- name: ' + sys.argv[2] + '\n'):
        print(block)
        break
PYEOF
}

MCP_BLOCK="$(route_block "${WORK}/mcp.yml" mcp)"
if [[ -z "${MCP_BLOCK}" ]]; then
  echo "FAIL: K-4/K-5: no 'mcp' route rendered" >&2
  exit 1
fi
if grep -q -- '- name: jwt$' <<<"${MCP_BLOCK}"; then
  echo "FAIL: K-5: the /mcp route has a jwt plugin; mcp-service verifies its own audience-bound token" >&2
  exit 1
fi
for h in X-User-Id X-User-Roles X-User-Id-Sig; do
  if ! grep -q "${h}" <<<"${MCP_BLOCK}"; then
    echo "FAIL: K-4: the /mcp route does not clear inbound ${h}" >&2
    exit 1
  fi
done
if ! grep -q 'limit_by: ip' <<<"${MCP_BLOCK}"; then
  echo "FAIL: K-5: the /mcp route is not rate-limited by IP" >&2
  exit 1
fi
echo "PASS: K-4/K-5: /mcp has no jwt plugin, clears X-User-* and is IP rate-limited"

PRM_BLOCK="$(route_block "${WORK}/mcp.yml" mcp-protected-resource-metadata)"
if [[ -z "${PRM_BLOCK}" ]] || grep -q -- '- name: jwt$' <<<"${PRM_BLOCK}" \
   || ! grep -q 'oauth-protected-resource' <<<"${PRM_BLOCK}"; then
  echo "FAIL: K-5: protected-resource metadata route missing, or has a jwt plugin" >&2
  exit 1
fi
echo "PASS: K-5: protected-resource metadata is a public route without a jwt plugin"

# Second jwt_secret: same RSA key, keyed on the issuer so tokens whose iss is the
# OAuth issuer verify. Without it every exchanged/MCP token would be 401 once
# auth-service flips OAUTH_ISSUER_ENABLED.
if ! grep -q -- "- key: ${ISSUER}\$" "${WORK}/mcp.yml" \
   || [[ "$(grep -c 'rsa_public_key:' "${WORK}/mcp.yml")" != "2" ]]; then
  echo "FAIL: K-5: expected a second RS256 jwt_secret keyed on the OAuth issuer" >&2
  exit 1
fi
echo "PASS: K-5: a second jwt_secret keyed on the OAuth issuer is rendered"

# REST audience rule: the scope guard must name the API audience derived from the issuer.
if [[ "$(grep -c "${ISSUER}/api\"" "${WORK}/mcp.yml")" -lt 1 ]]; then
  echo "FAIL: K-1: the REST audience (${ISSUER}/api) is not rendered into the scope guard" >&2
  exit 1
fi
if grep -q 'API_AUDIENCE_PLACEHOLDER' "${WORK}/mcp.yml"; then
  echo "FAIL: K-1: an audience placeholder was left unresolved" >&2
  exit 1
fi
echo "PASS: K-1: the scope guard embeds the API audience derived from the OAuth issuer"

# Guard counts unchanged by the new routes (they carry no jwt plugin).
SCOPE_N="$(grep -c '{{SCOPE_CHECK_LUA:' "${GATEWAY_DIR}/config/kong.base.yml")"
DENY_N="$(grep -c '{{OAUTH_DENY_LUA}}' "${GATEWAY_DIR}/config/kong.base.yml")"
if [[ "${SCOPE_N}" != "11" || "${DENY_N}" != "17" ]]; then
  echo "FAIL: guard counts changed (scope=${SCOPE_N} deny=${DENY_N}, expected 11/17); a new jwt route needs a deliberate guard" >&2
  exit 1
fi
echo "PASS: guard counts are SCOPE 11 / DENY 17"

# The issuer is a build input: missing or malformed must fail loud, never fall
# back to a hard-coded origin. dev/staging/prod have no values-file default.
for e in dev staging prod; do
  if out="$(env -u KONG_OAUTH_ISSUER "${WORK}/scripts/build.sh" "${e}" "${WORK}/x.yml" 2>&1)"; then
    echo "FAIL: K-5: ${e} rendered the MCP routes without KONG_OAUTH_ISSUER" >&2
    exit 1
  fi
  if ! grep -q 'KONG_OAUTH_ISSUER' <<<"${out}"; then
    echo "FAIL: K-5: ${e}: build failed, but not naming KONG_OAUTH_ISSUER:" >&2
    echo "${out}" >&2
    exit 1
  fi
done
echo "PASS: K-5: dev/staging/prod refuse to render without KONG_OAUTH_ISSUER"

for bad in "https://ticketing.example.com/api" "ticketing.example.com" "https://ticketing.example.com?x=1"; do
  if out="$(KONG_OAUTH_ISSUER="${bad}" "${WORK}/scripts/build.sh" prod "${WORK}/x.yml" 2>&1)"; then
    echo "FAIL: K-5: prod accepted a non-origin issuer" >&2
    exit 1
  fi
  if ! grep -q 'KONG_OAUTH_ISSUER' <<<"${out}"; then
    echo "FAIL: K-5: non-origin issuer rejected, but not naming KONG_OAUTH_ISSUER" >&2
    exit 1
  fi
done
if KONG_OAUTH_ISSUER="http://ticketing.example.com" "${WORK}/scripts/build.sh" prod "${WORK}/x.yml" >/dev/null 2>&1; then
  echo "FAIL: K-5: prod accepted a plain-http issuer (auth-service refuses it in production)" >&2
  exit 1
fi
echo "PASS: K-5: a non-origin or non-https (outside local/minikube) issuer is rejected"

# local keeps working with no env input (compose passes none): dev origin from the values file.
if ! out="$(env -u KONG_OAUTH_ISSUER "${WORK}/scripts/build.sh" local "${WORK}/x.yml" 2>&1)" \
   || ! grep -q -- '- key: http://localhost:8000$' "${WORK}/x.yml"; then
  echo "FAIL: K-5: local did not fall back to the dev origin http://localhost:8000" >&2
  echo "${out}" >&2
  exit 1
fi
echo "PASS: K-5: local falls back to the dev origin from its values file"
