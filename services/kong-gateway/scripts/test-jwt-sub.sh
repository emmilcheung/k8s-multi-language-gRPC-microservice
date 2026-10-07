#!/usr/bin/env bash
# services/kong-gateway/scripts/test-jwt-sub.sh
#
# Behavioural test of plugins/jwt-sub.lua (identity + platform-role headers).
# Runs the REAL Lua, with SIGNING_KEY_PLACEHOLDER substituted the way build.sh does it,
# under `resty` in a one-shot container of the same Kong image validate.sh uses.
# Only the kong PDK pieces the snippet touches are stubbed
# (kong.ctx.shared.authenticated_jwt_token, kong.service.request.set_header/clear_header).
# Expected signatures are computed with resty.openssl, independent of the snippet's own HMAC.
#
# Needs docker. Without it the test FAILS (exit 2) unless KONG_TEST_SKIP_DOCKER=1
# is set explicitly; it never passes silently.
#
# Usage: ./scripts/test-jwt-sub.sh

set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KONG_IMAGE="kong:3.7-ubuntu"   # keep in step with validate.sh

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [[ "${KONG_TEST_SKIP_DOCKER:-}" == "1" ]]; then
    echo "SKIP (LOUD): docker unavailable and KONG_TEST_SKIP_DOCKER=1; jwt-sub header behaviour was NOT tested" >&2
    exit 0
  fi
  echo "FAIL: docker is required to run the jwt-sub behavioural test (set KONG_TEST_SKIP_DOCKER=1 to skip explicitly)" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
chmod 755 "${WORK}"

KEY="0123456789abcdef0123456789abcdef0123456789abcdef"
sed -e "s|SIGNING_KEY_PLACEHOLDER|${KEY}|" "${GATEWAY_DIR}/plugins/jwt-sub.lua" > "${WORK}/sub.lua"
sed -e "s|SIGNING_KEY_PLACEHOLDER||" "${GATEWAY_DIR}/plugins/jwt-sub.lua" > "${WORK}/sub-nokey.lua"

cat > "${WORK}/harness.lua" <<'LUAEOF'
local KEY = arg[3]
local NOW = 1760000000
local MINUTE = math.floor(NOW / 60)
local hmac = require("resty.openssl.hmac")

local function b64url(s)
  return (ngx.encode_base64(s):gsub("+", "-"):gsub("/", "_"):gsub("=", ""))
end

local function sign(message)
  return ngx.encode_base64(hmac.new(KEY, "sha256"):final(message))
end

local failed = 0
local function check(label, ok, detail)
  if ok then
    print("PASS: " .. label)
  else
    failed = failed + 1
    print("FAIL: " .. label .. (detail and (" -> " .. detail) or ""))
  end
end

-- Runs the plugin against a token payload; `incoming` are headers a client sent.
local function run(file, payload, incoming)
  local headers = {}
  for k, v in pairs(incoming or {}) do headers[k] = v end
  _G.ngx.now = function() return NOW end
  _G.kong = {
    ctx = { shared = { authenticated_jwt_token = "h." .. b64url(payload) .. ".s" } },
    service = { request = {
      set_header = function(k, v) headers[k] = v end,
      clear_header = function(k) headers[k] = nil end,
    } },
  }
  assert(loadfile(file))()
  return headers
end

local SUB = "550e8400-e29b-41d4-a716-446655440000"
local SUB_SIG = sign(SUB .. "|" .. MINUTE)

-- existing behaviour stays byte-for-byte
local h = run(arg[1], '{"sub":"' .. SUB .. '"}')
check("user id signature is still HMAC(userId|minute)", h["X-User-Id"] == SUB and h["X-User-Id-Sig"] == SUB_SIG, tostring(h["X-User-Id-Sig"]))

-- roles are signed over userId|roles|minute
h = run(arg[1], '{"sub":"' .. SUB .. '","roles":["platform_admin","organizer"]}')
check("roles are forwarded as a comma-separated list", h["X-User-Roles"] == "platform_admin,organizer", tostring(h["X-User-Roles"]))
check("roles carry a signature over userId|roles|minute",
  h["X-User-Roles-Sig"] == sign(SUB .. "|platform_admin,organizer|" .. MINUTE), tostring(h["X-User-Roles-Sig"]))
check("roles signature is not the user id signature", h["X-User-Roles-Sig"] ~= h["X-User-Id-Sig"])
check("user id signature is unchanged when roles are present", h["X-User-Id-Sig"] == SUB_SIG)

-- a token without roles sends no roles signature
h = run(arg[1], '{"sub":"' .. SUB .. '"}')
check("a token without roles gets no roles header and no roles signature",
  h["X-User-Roles"] == nil and h["X-User-Roles-Sig"] == nil)

-- client-supplied copies never survive
local forged = { ["X-User-Roles"] = "platform_admin", ["X-User-Roles-Sig"] = "forged" }
h = run(arg[1], '{"sub":"' .. SUB .. '"}', forged)
check("a client-supplied X-User-Roles or X-User-Roles-Sig is stripped when the token has no roles",
  h["X-User-Roles"] == nil and h["X-User-Roles-Sig"] == nil,
  tostring(h["X-User-Roles"]) .. " / " .. tostring(h["X-User-Roles-Sig"]))
h = run(arg[1], '{"sub":"' .. SUB .. '","roles":["buyer"]}', forged)
check("a client-supplied X-User-Roles-Sig is replaced by the gateway's own",
  h["X-User-Roles"] == "buyer" and h["X-User-Roles-Sig"] == sign(SUB .. "|buyer|" .. MINUTE))
h = run(arg[1], '{"iss":"anon"}', forged)
check("a token without a subject leaves no roles headers",
  h["X-User-Roles"] == nil and h["X-User-Roles-Sig"] == nil)

-- delegated (OAuth/MCP) tokens never produce platform roles
h = run(arg[1], '{"sub":"' .. SUB .. '","client_id":"mcp","scope":"orders:read","roles":["platform_admin"]}')
check("delegated (MCP) tokens never produce platform roles",
  h["X-User-Roles"] == nil and h["X-User-Roles-Sig"] == nil, tostring(h["X-User-Roles"]))
check("delegated tokens still identify the consenting user", h["X-User-Id"] == SUB and h["X-User-Id-Sig"] == SUB_SIG)

-- the gateway must not forge a signature without a key
h = run(arg[2], '{"sub":"' .. SUB .. '","roles":["platform_admin"]}')
check("without a signing key no signature headers are produced",
  h["X-User-Id-Sig"] == nil and h["X-User-Roles-Sig"] == nil)

os.exit(failed == 0 and 0 or 1)
LUAEOF

if out="$(docker run --rm --volume "${WORK}:/t:ro" "${KONG_IMAGE}" \
    resty /t/harness.lua /t/sub.lua /t/sub-nokey.lua "${KEY}" 2>&1)"; then
  rc=0
else
  rc=$?
fi
echo "${out}" | grep -E '^(PASS|FAIL):' || echo "${out}" | tail -20
total="$(grep -cE '^(PASS|FAIL):' <<<"${out}" || true)"
if [[ "${rc}" -ne 0 || "${total}" -lt 12 ]]; then
  echo "FAIL: jwt-sub behavioural test (resty exit ${rc}, ${total} cases reported)" >&2
  exit 1
fi
echo "PASS: jwt-sub identity and platform-role headers (${total} cases)"
