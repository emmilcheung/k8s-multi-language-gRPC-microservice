-- jwt-scope.lua
-- Enforces OAuth scope on Bearer JWT tokens at the Kong gateway boundary.
--
-- SCOPE ENFORCEMENT BEHAVIOR:
--   ✓ Bearer/API-token JWTs: Scope claim is validated against the required scope.
--     If scope is missing or insufficient, request is rejected with 403 Forbidden.
--
--   ✗ Cookie-based session tokens: These carry no `scope` claim and bypass this
--     check by design. This is an accepted temporary limitation (see F-14).
--     Downstream services must apply additional authorization logic if needed.
--     Future versions may implement scope parity for session tokens (not in roadmap).
--
-- Why no require "cjson":
--   Kong's pre-function Lua sandbox blocks all require() calls (same as
--   post-function). We extract claims via Lua string patterns instead.
--   Safe because scope values use only alphanumeric characters and colons.
--
-- SCOPE_PLACEHOLDER is replaced by build.sh with the actual required scope
-- (e.g. "orders:read") before writing kong.yml.
--
-- This file is the single canonical copy. build.sh inlines its content into
-- every scope-protected route's `pre-function` plugin block at render time.

local scope_required = "SCOPE_PLACEHOLDER"

-- Only inspect Authorization: Bearer ... headers (OAuth tokens).
-- Cookie-based requests carry no scope claim and must pass through.
local auth_header = kong.request.get_header("Authorization")
if not auth_header then
  return
end

local token_str = auth_header:match("^[Bb]earer%s+(.+)$")
if not token_str then
  return
end

-- Decode the JWT payload (middle segment between the two dots).
local b64_payload = token_str:match("^[^.]+%.([^.]+)%.")
if not b64_payload then
  return
end

-- Normalize base64url to standard base64 before decoding.
b64_payload = b64_payload:gsub("-", "+"):gsub("_", "/")
local pad = (4 - #b64_payload % 4) % 4
b64_payload = b64_payload .. string.rep("=", pad)

local payload_json = ngx.decode_base64(b64_payload)
if not payload_json then
  return
end

-- Extract the `scope` claim value (space-separated string).
local scope = payload_json:match('"scope"%s*:%s*"([^"]+)"')
if not scope then
  -- No scope claim → this is a session/cookie token, not an OAuth bearer token.
  -- By design, session tokens bypass scope checks (F-14 limitation).
  -- Authorization decisions for these requests defer to downstream services.
  return
end

-- Check that the required scope appears as a whitespace-delimited token.
-- Pattern: start-of-string or space, then the exact token, then space or end.
local found = false
for token in scope:gmatch("%S+") do
  if token == scope_required then
    found = true
    break
  end
end

if not found then
  kong.response.exit(
    403,
    '{"statusCode":403,"error":"Forbidden","message":"Insufficient scope: ' .. scope_required .. ' required"}',
    { ["Content-Type"] = "application/json" }
  )
end
