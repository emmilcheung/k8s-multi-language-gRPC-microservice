#!/usr/bin/env bash
# services/kong-gateway/scripts/test-queue-gate.sh
#
# Behavioural test of plugins/queue-gate.lua (the waiting-room backstop).
# Runs the REAL Lua, with its placeholders substituted the way build.sh does it,
# under `resty` in a one-shot container of the same Kong image validate.sh uses.
# Only the kong PDK pieces the snippet touches are stubbed.
#
# Why it exists: while a sale is armed, the queue is the only thing standing
# between a bot and the seat map. A gate that only checks the pass signature lets
# one pass be replayed after it expires, for another event, or by another
# account; a gate that matches GraphQL text loosely lets a renamed, escaped or
# hash-only (persisted) query through. Each case below is one of those holes.
#
# Needs docker. Without it the test FAILS (exit 2) unless KONG_TEST_SKIP_DOCKER=1
# is set explicitly; it never passes silently.
#
# Usage: ./scripts/test-queue-gate.sh

set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KONG_IMAGE="kong:3.7-ubuntu"   # keep in step with validate.sh

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [[ "${KONG_TEST_SKIP_DOCKER:-}" == "1" ]]; then
    echo "SKIP (LOUD): docker unavailable and KONG_TEST_SKIP_DOCKER=1; the queue gate was NOT tested" >&2
    exit 0
  fi
  echo "FAIL: docker is required to run the queue gate behavioural test (set KONG_TEST_SKIP_DOCKER=1 to skip explicitly)" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
chmod 755 "${WORK}"

SECRET="queue-gate-test-secret-0123456789abcdef"
EVENT="11111111-2222-3333-4444-555555555555"
render() { # <mode> <armed> <out>
  sed -e "s|QUEUE_GATE_MODE_PLACEHOLDER|$1|" -e "s|{{QUEUE_GATE_ARMED}}|$2|" \
      -e "s|{{QUEUE_HMAC_SECRET}}|${SECRET}|" -e "s|{{QUEUE_EVENT_ID}}|${EVENT}|" \
      "${GATEWAY_DIR}/plugins/queue-gate.lua" > "$3"
}
render graphql-purchase true  "${WORK}/graphql.lua"
render always           true  "${WORK}/always.lua"
render graphql-purchase false "${WORK}/disarmed.lua"

cat > "${WORK}/harness.lua" <<'LUAEOF'
local dir, SECRET, EVENT = arg[1], arg[2], arg[3]
local cjson = require("cjson.safe")

local function b64url(s)
  return (ngx.encode_base64(s):gsub("+", "-"):gsub("/", "_"):gsub("=", ""))
end

-- Mint a pass the way queue-service TokenService.Sign does.
local function pass(fields)
  local body = b64url(cjson.encode(fields))
  local h = require("resty.openssl.hmac").new(SECRET, "sha256")
  h:update(body)
  return body .. "." .. b64url(h:final())
end

local now = ngx.time()
local USER, OTHER = "user-a", "user-b"
local good      = pass({ Eid = EVENT, Mid = "m1", Sub = USER, Iat = now, Exp = now + 900, Nonce = "n" })
local expired   = pass({ Eid = EVENT, Mid = "m1", Sub = USER, Iat = now - 1000, Exp = now - 1, Nonce = "n" })
local other_evt = pass({ Eid = "99999999-0000-0000-0000-000000000000", Mid = "m1", Sub = USER, Iat = now, Exp = now + 900, Nonce = "n" })
local other_usr = pass({ Eid = EVENT, Mid = "m1", Sub = OTHER, Iat = now, Exp = now + 900, Nonce = "n" })
local no_sub    = pass({ Eid = EVENT, Mid = "m1", Iat = now, Exp = now + 900, Nonce = "n" })
local tampered  = good:sub(1, -3) .. (good:sub(-2, -2) == "A" and "BA" or "AA")

local function jwt(sub)
  local claims = sub and { iss = "auth-service", sub = sub } or { iss = "anonymous" }
  return "h." .. b64url(cjson.encode(claims)) .. ".s"
end

local function gql(query) return cjson.encode({ query = query }) end
local HOLD   = gql('mutation { holdSeats(planId: "p", seatIds: ["s"]) { id } }')
local READ   = gql('query { event(id: "e") { title seatingPlan { reservedCount } } }')
local APQ    = cjson.encode({ operationName = "Hold", variables = {},
  extensions = { persistedQuery = { version = 1, sha256Hash = string.rep("a", 64) } } })
-- S is "S": the router decodes JSON before parsing GraphQL, so must the gate.
local ESCAPED = '{"query":"mutation { hold\\u0053eats(planId: \\"p\\", seatIds: []) { id } }"}'

-- { label, script, method, body, cookie pass, jwt sub, expected status or nil for "passes through" }
local cases = {
  { "read query, no pass",                         "graphql", "POST", READ, nil, USER, nil },
  { "holdSeats, no pass",                          "graphql", "POST", HOLD, nil, USER, 403 },
  { "holdSeats, valid pass for this user",         "graphql", "POST", HOLD, good, USER, nil },
  { "holdSeats, expired pass",                     "graphql", "POST", HOLD, expired, USER, 403 },
  { "holdSeats, another event's pass",             "graphql", "POST", HOLD, other_evt, USER, 403 },
  { "holdSeats, another user's pass",              "graphql", "POST", HOLD, other_usr, USER, 403 },
  { "holdSeats, pass without a user",              "graphql", "POST", HOLD, no_sub, USER, 403 },
  { "holdSeats, valid pass but anonymous caller",  "graphql", "POST", HOLD, good, nil, 403 },
  { "holdSeats, tampered signature",               "graphql", "POST", HOLD, tampered, USER, 403 },
  { "createSeatedOrder under an alias, no pass",   "graphql", "POST",
    gql('mutation { buy: createSeatedOrder(input: {}) { id } }'), nil, USER, 403 },
  { "createOrder, no pass",                        "graphql", "POST",
    gql('mutation{createOrder(input:{}){id}}'), nil, USER, 403 },
  { "createOrder, another user's pass",            "graphql", "POST",
    gql('mutation{createOrder(input:{}){id}}'), other_usr, USER, 403 },
  { "field name hidden by a JSON escape, no pass", "graphql", "POST", ESCAPED, nil, USER, 403 },
  { "hash-only persisted query, valid pass",       "graphql", "POST", APQ, good, USER, 403 },
  { "batched body hiding a purchase, no pass",     "graphql", "POST",
    cjson.encode({ { query = "query { me { id } }" }, { query = "mutation { createOrder(input: {}) { id } }" } }),
    nil, USER, 403 },
  { "body that is not JSON",                       "graphql", "POST", "mutation { holdSeats }", nil, USER, 400 },
  { "payment is never gated",                      "graphql", "POST",
    gql('mutation { createPayment(orderId: "o") { id } }'), nil, USER, nil },
  { "releasing seats is never gated",              "graphql", "POST",
    gql('mutation { releaseSeats(planId: "p", seatIds: ["s"]) }'), nil, USER, nil },
  { "a longer name containing a gated one",        "graphql", "POST",
    gql('query { createOrderPreview { id } }'), nil, USER, nil },
  { "CORS preflight",                              "graphql", "OPTIONS", "", nil, nil, nil },
  { "REST route, no pass",                         "always",  "POST", "{}", nil, USER, 403 },
  { "REST route, valid pass",                      "always",  "POST", "{}", good, USER, nil },
  { "REST route, expired pass",                    "always",  "POST", "{}", expired, USER, 403 },
  { "REST route, another event's pass",            "always",  "POST", "{}", other_evt, USER, 403 },
  { "REST route, another user's pass",             "always",  "POST", "{}", other_usr, USER, 403 },
  { "REST route, pass under a look-alike cookie",  "always",  "POST", "{}", "xqq_pass", USER, 403 },
  { "gate not armed: holdSeats, no pass",          "disarmed", "POST", HOLD, nil, USER, nil },
}

local failed = 0
for _, c in ipairs(cases) do
  local label, script, method, body, cookie_pass, sub, want = c[1], c[2], c[3], c[4], c[5], c[6], c[7]
  local cookie = "other=1"
  if cookie_pass == "xqq_pass" then
    cookie = "xqq_pass=" .. good
  elseif cookie_pass then
    cookie = "other=1; qq_pass=" .. cookie_pass
  end
  local exit_status, exit_calls = nil, 0
  -- Like real Kong, the first exit decides the response; a second call means
  -- the snippet kept running after exiting (a dropped `return`).
  _G.kong = {
    ctx = { shared = { authenticated_jwt_token = jwt(sub) } },
    request = {
      get_method = function() return method end,
      get_header = function(name) if name:lower() == "cookie" then return cookie end end,
      -- Same contract as the PDK: a decoded table, or nil plus an error.
      get_body = function(mime)
        assert(mime == "application/json", "the gate must force JSON parsing")
        local t, err = cjson.decode(body)
        if t == nil then return nil, err or "invalid json" end
        return t
      end,
    },
    response = { exit = function(status)
      exit_calls = exit_calls + 1
      if exit_status == nil then exit_status = status end
    end },
  }
  local chunk = assert(loadfile(dir .. "/" .. script .. ".lua"))
  chunk()
  if exit_calls > 1 then
    failed = failed + 1
    print("FAIL: " .. label .. " -> exit called " .. exit_calls .. " times")
  elseif exit_status == want then
    print("PASS: " .. label .. " -> " .. tostring(exit_status or "pass"))
  else
    failed = failed + 1
    print("FAIL: " .. label .. " -> got " .. tostring(exit_status or "pass") .. ", want " .. tostring(want or "pass"))
  end
end
-- resty prints noisy timer errors on stderr in some images; the exit code is the contract.
os.exit(failed == 0 and 0 or 1)
LUAEOF

if out="$(docker run --rm --volume "${WORK}:/t:ro" "${KONG_IMAGE}" \
    resty /t/harness.lua /t "${SECRET}" "${EVENT}" 2>&1)"; then
  rc=0
else
  rc=$?
fi
echo "${out}" | grep -E '^(PASS|FAIL):' || true
total="$(grep -cE '^(PASS|FAIL):' <<<"${out}" || true)"
if [[ "${rc}" -ne 0 || "${total}" -lt 27 ]]; then
  [[ "${total}" -eq 0 ]] && echo "${out}" >&2
  echo "FAIL: queue gate behavioural test (resty exit ${rc}, ${total} cases reported)" >&2
  exit 1
fi
echo "PASS: queue gate behaviour (${total} cases)"
