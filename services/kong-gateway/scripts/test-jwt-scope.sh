#!/usr/bin/env bash
# services/kong-gateway/scripts/test-jwt-scope.sh
#
# Behavioural test of plugins/jwt-scope.lua (REST audience rule + scope gate).
# Runs the REAL Lua, with its placeholders substituted the way build.sh does it,
# under `resty` in a one-shot container of the same Kong image validate.sh uses.
# Only the kong PDK pieces the snippet touches are stubbed
# (kong.ctx.shared.authenticated_jwt_token, kong.response.exit).
#
# Why it exists: test-build-lint.sh only proves the audience string is rendered.
# This is what fails if the rule itself is disabled or its parsing is broken, i.e.
# if an MCP-audience token could reach a REST route.
#
# Needs docker. Without it the test FAILS (exit 2) unless KONG_TEST_SKIP_DOCKER=1
# is set explicitly; it never passes silently.
#
# Usage: ./scripts/test-jwt-scope.sh

set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KONG_IMAGE="kong:3.7-ubuntu"   # keep in step with validate.sh

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [[ "${KONG_TEST_SKIP_DOCKER:-}" == "1" ]]; then
    echo "SKIP (LOUD): docker unavailable and KONG_TEST_SKIP_DOCKER=1; the jwt-scope audience rule was NOT tested" >&2
    exit 0
  fi
  echo "FAIL: docker is required to run the jwt-scope behavioural test (set KONG_TEST_SKIP_DOCKER=1 to skip explicitly)" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
chmod 755 "${WORK}"

API_AUD="https://ticketing.example.com/api"
MCP_AUD="https://ticketing.example.com/mcp"
sed -e 's|SCOPE_PLACEHOLDER|orders:read|' -e "s|API_AUDIENCE_PLACEHOLDER|${API_AUD}|" \
  "${GATEWAY_DIR}/plugins/jwt-scope.lua" > "${WORK}/scope.lua"

cat > "${WORK}/harness.lua" <<'LUAEOF'
local API, MCP = arg[2], arg[3]

local function b64url(s)
  return (ngx.encode_base64(s):gsub("+", "-"):gsub("/", "_"):gsub("=", ""))
end

-- { label, payload JSON, expected exit status or nil for "passes through" }
local cases = {
  { "browser token, no client_id, no aud", '{"iss":"auth-service","sub":"u"}', nil },
  { "browser token with an unrelated aud", '{"iss":"auth-service","sub":"u","aud":"' .. MCP .. '"}', nil },
  { "oauth + aud = API audience", '{"client_id":"c","scope":"orders:read","aud":"' .. API .. '"}', nil },
  { "oauth + aud = MCP audience", '{"client_id":"c","scope":"orders:read","aud":"' .. MCP .. '"}', 401 },
  { "oauth + aud array containing API", '{"client_id":"c","scope":"orders:read","aud":["x","' .. API .. '"]}', nil },
  { "oauth + aud array with only MCP", '{"client_id":"c","scope":"orders:read","aud":["' .. MCP .. '"]}', 401 },
  { "aud = API + /x (prefix)", '{"client_id":"c","scope":"orders:read","aud":"' .. API .. '/x"}', 401 },
  { "aud = API + trailing slash", '{"client_id":"c","scope":"orders:read","aud":"' .. API .. '/"}', 401 },
  { "aud with upper-case host", '{"client_id":"c","scope":"orders:read","aud":"' .. API:gsub("ticketing", "TICKETING") .. '"}', 401 },
  { "oauth with no aud (tolerated for now)", '{"client_id":"c","scope":"orders:read"}', nil },
  { "escaped fake aud inside another claim + real MCP aud",
    '{"client_id":"c","scope":"orders:read","note":"x\\"aud\\":\\"' .. API .. '\\"","aud":"' .. MCP .. '"}', 401 },
  { "right aud, missing scope -> scope still enforced", '{"client_id":"c","scope":"tickets:read","aud":"' .. API .. '"}', 403 },
  { "wrong aud, right scope -> audience wins", '{"client_id":"c","scope":"orders:read","aud":"' .. MCP .. '"}', 401 },
  { "wrong aud AND unsatisfied scope -> audience judged first", '{"client_id":"c","scope":"tickets:read","aud":"' .. MCP .. '"}', 401 },
  { "oauth, no aud, no scope -> fail closed", '{"client_id":"c"}', 403 },
}

local failed = 0
for _, c in ipairs(cases) do
  local exit_status, exit_calls, noticed = nil, 0, false
  -- Like real Kong, the first exit decides the response; a second call means
  -- the snippet kept running after exiting (a dropped `return`).
  _G.kong = {
    ctx = { shared = { authenticated_jwt_token = "h." .. b64url(c[2]) .. ".s" } },
    log = { notice = function() noticed = true end },
    response = { exit = function(status)
      exit_calls = exit_calls + 1
      if exit_status == nil then exit_status = status end
    end },
  }
  local chunk = assert(loadfile(arg[1]))
  chunk()
  -- The audience-less token that is let through must leave a trace; nothing else may.
  local want_notice = c[2]:find('"client_id"', 1, true) ~= nil and c[2]:find('"aud"', 1, true) == nil
  if noticed ~= want_notice then
    failed = failed + 1
    print("FAIL: " .. c[1] .. " -> notice logged: " .. tostring(noticed) .. ", want " .. tostring(want_notice))
  elseif exit_calls > 1 then
    failed = failed + 1
    print("FAIL: " .. c[1] .. " -> exit called " .. exit_calls .. " times")
  elseif exit_status == c[3] then
    print("PASS: " .. c[1] .. " -> " .. tostring(exit_status or "pass"))
  else
    failed = failed + 1
    print("FAIL: " .. c[1] .. " -> got " .. tostring(exit_status or "pass") .. ", want " .. tostring(c[3] or "pass"))
  end
end
-- resty prints noisy timer errors on stderr in some images; the exit code is the contract.
os.exit(failed == 0 and 0 or 1)
LUAEOF

if out="$(docker run --rm --volume "${WORK}:/t:ro" "${KONG_IMAGE}" \
    resty /t/harness.lua /t/scope.lua "${API_AUD}" "${MCP_AUD}" 2>/dev/null)"; then
  rc=0
else
  rc=$?
fi
echo "${out}" | grep -E '^(PASS|FAIL):' || true
total="$(grep -cE '^(PASS|FAIL):' <<<"${out}" || true)"
if [[ "${rc}" -ne 0 || "${total}" -lt 15 ]]; then
  echo "FAIL: jwt-scope behavioural test (resty exit ${rc}, ${total} cases reported)" >&2
  exit 1
fi
echo "PASS: jwt-scope audience/scope behaviour (${total} cases)"
