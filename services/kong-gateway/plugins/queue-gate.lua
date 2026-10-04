-- queue-gate.lua
-- Virtual waiting-room backstop (inert unless QUEUE_GATE_ARMED is "true").
--
-- A purchase write must carry a qq_pass cookie of the form <b64>.<sig>, where
-- sig is base64url(HMAC-SHA256(QUEUE_HMAC_SECRET, b64)), minted by queue-service.
-- Pass source is the cookie only. Beyond the signature, the pass must be
-- unexpired, for the armed event (QUEUE_EVENT_ID), and issued to the caller:
-- its Sub must equal the sub of the JWT the jwt plugin validated. So this
-- snippet runs in a post-function, after jwt.
--
-- QUEUE_GATE_MODE_PLACEHOLDER is replaced by build.sh with the mode:
--   graphql-purchase : gate only GraphQL bodies that name a field in
--                      GATED_FIELDS (scripts/test-build-lint.sh checks each
--                      name still exists in the supergraph's Mutation type)
--   always           : gate every request on the route (REST hold and order)
--
-- Payment is never gated: a pass that expires mid-checkout must not strand a
-- buyer who already holds seats. Releasing seats is never gated either.
--
-- require() works here only because the gateway image and the helm values
-- set KONG_UNTRUSTED_LUA_SANDBOX_REQUIRES=resty.openssl.hmac.

local mode = "QUEUE_GATE_MODE_PLACEHOLDER"
if "{{QUEUE_GATE_ARMED}}" ~= "true" then return end

local GATED_FIELDS = { "holdSeats", "createSeatedOrder", "createOrder" }

if mode == "graphql-purchase" then
  if kong.request.get_method() == "OPTIONS" then return end
  -- Parse the JSON instead of searching the raw bytes: the router decodes JSON
  -- escapes before it parses GraphQL, so "holdSeats" is holdSeats to it.
  -- A body Kong cannot decode (not JSON, or larger than the client body
  -- buffer) is refused while armed rather than waved through.
  local body = kong.request.get_body("application/json")
  if type(body) ~= "table" then
    return kong.response.exit(400, { message = "waiting room: GraphQL body must be JSON" })
  end
  local ops = body[1] ~= nil and body or { body }
  local gated = false
  for _, op in ipairs(ops) do
    local query = type(op) == "table" and op.query or nil
    if type(query) ~= "string" then
      -- A hash-only persisted query carries no text to inspect.
      return kong.response.exit(403, { message = "waiting room: query text required" })
    end
    for _, field in ipairs(GATED_FIELDS) do
      -- Whole GraphQL names only; an alias ("buy: createOrder") still names the field.
      if query:find("%f[%w_]" .. field .. "%f[^%w_]") then gated = true end
    end
  end
  if not gated then return end
end

local function b64url_decode(s)
  s = s:gsub("-", "+"):gsub("_", "/")
  return ngx.decode_base64(s .. string.rep("=", (4 - #s % 4) % 4))
end

local cookie = "; " .. (kong.request.get_header("Cookie") or "")
local token = cookie:match(";%s*qq_pass=([^;]+)")
if not token then
  return kong.response.exit(403, { message = "waiting room: pass required" })
end
local b64, sig = token:match("^([^%.]+)%.([^%.]+)$")
if not b64 then
  return kong.response.exit(403, { message = "waiting room: malformed pass" })
end
local secret = "{{QUEUE_HMAC_SECRET}}"
if secret == "" then
  -- build.sh refuses to render this; never accept a pass signed with an empty key.
  return kong.response.exit(503, { message = "waiting room unavailable" })
end
local hmac = require("resty.openssl.hmac").new(secret, "sha256")
hmac:update(b64)
local expected = ngx.encode_base64(hmac:final()):gsub("%+", "-"):gsub("/", "_"):gsub("=+$", "")
-- Constant-time compare: length check, then accumulate the byte differences
-- over the whole string (no early return). The sandbox has no bit library, so
-- the accumulator sums absolute differences instead of XOR-ing; it is zero only
-- when every byte matches.
local diff = #expected == #sig and 0 or 1
if diff == 0 then
  for i = 1, #expected do
    diff = diff + math.abs(expected:byte(i) - sig:byte(i))
  end
end
if diff ~= 0 then
  return kong.response.exit(403, { message = "waiting room: invalid pass" })
end

-- The payload is trusted from here on (we signed it), so string patterns are
-- enough; the sandbox blocks require("cjson").
local payload = b64url_decode(b64) or ""
local exp = tonumber(payload:match('"Exp"%s*:%s*(%d+)'))
if not exp or exp <= ngx.time() then
  return kong.response.exit(403, { message = "waiting room: pass expired" })
end
if payload:match('"Eid"%s*:%s*"([^"]*)"') ~= "{{QUEUE_EVENT_ID}}" then
  return kong.response.exit(403, { message = "waiting room: pass is for another event" })
end
local pass_sub = payload:match('"Sub"%s*:%s*"([^"]+)"')
local jwt_token = kong.ctx.shared.authenticated_jwt_token
local jwt_payload = type(jwt_token) == "string" and jwt_token:match("^[^.]+%.([^.]+)%.")
local caller_sub = jwt_payload and (b64url_decode(jwt_payload) or ""):match('"sub"%s*:%s*"([^"]+)"')
if not pass_sub or pass_sub ~= caller_sub then
  return kong.response.exit(403, { message = "waiting room: pass belongs to another account" })
end
