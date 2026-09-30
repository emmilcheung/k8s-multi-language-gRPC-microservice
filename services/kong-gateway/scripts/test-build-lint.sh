#!/usr/bin/env bash
# services/kong-gateway/scripts/test-build-lint.sh
#
# Negative tests for build.sh. Works on a temp copy of the gateway dir, so the
# real config is never touched.
#   1. OAuth-guard lint: a jwt route whose guard is the SECOND post-function
#      access entry must fail the build.
#   2. Queue secret: an armed gate outside local must refuse the committed dev
#      QUEUE_HMAC_SECRET (without printing it) and accept an injected one.
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
