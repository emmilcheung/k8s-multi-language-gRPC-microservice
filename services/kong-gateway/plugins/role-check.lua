-- role-check.lua
-- Enforces role-based access control on authenticated users by inspecting the JWT payload.
--
-- This post-function runs after jwt-sub.lua and extracts the `roles` claim from the
-- JWT stored in kong.ctx.shared.authenticated_jwt_token. The `roles` claim is expected
-- to be a JSON array (e.g., ["organizer", "buyer"]).
--
-- If the required role is not found in the roles array, returns 403 Forbidden.
--
-- ROLE_PLACEHOLDER is replaced by build.sh with the actual required role
-- (e.g. "organizer") before writing kong.yml.
--
-- This file is the single canonical copy. build.sh inlines its content into
-- every role-protected route's `post-function` plugin block at render time.

local role_required = "ROLE_PLACEHOLDER"

local token_str = kong.ctx.shared.authenticated_jwt_token
if type(token_str) ~= "string" then
  kong.response.exit(
    403,
    '{"statusCode":403,"error":"Forbidden","message":"Token not found"}',
    { ["Content-Type"] = "application/json" }
  )
  return
end

-- Extract JWT payload: token format is header.payload.signature
local b64_payload = token_str:match("^[^.]+%.([^.]+)%.")
if not b64_payload then
  kong.response.exit(
    403,
    '{"statusCode":403,"error":"Forbidden","message":"Invalid token format"}',
    { ["Content-Type"] = "application/json" }
  )
  return
end

-- Normalize base64url to standard base64 before decoding.
b64_payload = b64_payload:gsub("-", "+"):gsub("_", "/")
local pad = (4 - #b64_payload % 4) % 4
b64_payload = b64_payload .. string.rep("=", pad)
local payload_json = ngx.decode_base64(b64_payload)

if not payload_json then
  kong.response.exit(
    403,
    '{"statusCode":403,"error":"Forbidden","message":"Could not decode token payload"}',
    { ["Content-Type"] = "application/json" }
  )
  return
end

-- Extract "roles":[...] from the JWT payload using simple pattern matching.
-- Pattern matches strings inside quotes within the array (e.g., ["organizer", "buyer"]).
local found = false
for role in payload_json:gmatch('"roles"%s*:%s*%[([^%]]+)%]') do
  for r in role:gmatch('"([^"]+)"') do
    if r == role_required then
      found = true
      break
    end
  end
  if found then break end
end

if not found then
  kong.response.exit(
    403,
    '{"statusCode":403,"error":"Forbidden","message":"Insufficient role: ' .. role_required .. ' required"}',
    { ["Content-Type"] = "application/json" }
  )
end
