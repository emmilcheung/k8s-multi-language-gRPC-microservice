-- queue-gate.lua
-- Virtual waiting-room backstop (inert unless QUEUE_GATE_ARMED is "true").
--
-- A request must carry a qq_pass cookie of the form <b64>.<sig>, where sig is
-- base64url(HMAC-SHA256(QUEUE_HMAC_SECRET, b64)), minted by queue-service.
-- Pass source is the cookie only.
--
-- QUEUE_GATE_MODE_PLACEHOLDER is replaced by build.sh with the mode:
--   graphql-reserve : gate only bodies containing "reserve" (GraphQL route)
--   always          : gate every request on the route (REST order creation, F3)
--
-- require() works here only because the gateway image and the helm values
-- set KONG_UNTRUSTED_LUA_SANDBOX_REQUIRES=resty.openssl.hmac (D13, F12).
-- Known gap, kept as-is: the pass HMAC is checked, but not its expiry, event
-- or single use.

local mode = "QUEUE_GATE_MODE_PLACEHOLDER"
if "{{QUEUE_GATE_ARMED}}" ~= "true" then return end
if mode == "graphql-reserve" then
  -- Only gate the reserve mutation; reads and SSR pass freely.
  local ok, body = pcall(function() return kong.request.get_raw_body() end)
  body = (ok and body) or ""
  if not body:find("reserve", 1, true) then return end
end
local cookie = kong.request.get_header("Cookie") or ""
local token = cookie:match("qq_pass=([^;]+)")
if not token then
  return kong.response.exit(403, { message = "waiting room: pass required" })
end
local b64, sig = token:match("^([^%.]+)%.([^%.]+)$")
if not b64 then
  return kong.response.exit(403, { message = "waiting room: malformed pass" })
end
local hmac = require("resty.openssl.hmac").new("{{QUEUE_HMAC_SECRET}}", "sha256")
hmac:update(b64)
local expected = ngx.encode_base64(hmac:final()):gsub("%+", "-"):gsub("/", "_"):gsub("=+$", "")
if expected ~= sig then
  return kong.response.exit(403, { message = "waiting room: invalid pass" })
end
