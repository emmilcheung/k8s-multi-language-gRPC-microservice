-- oauth-deny.lua
-- Refuses OAuth access tokens on a route that has no OAuth scope.
--
-- Runs as the FIRST post-function access entry, after the jwt plugin has
-- verified the token, and reads that verified token from
-- kong.ctx.shared.authenticated_jwt_token, so header and cookie are covered.
-- A token with a `client_id` claim was minted for an OAuth client (
-- invariant) and gets 403 insufficient_scope. Browser session tokens and the
-- anonymous GraphQL token carry no `client_id` and pass.
--
-- build.sh requires every jwt route to carry exactly one of this file or
-- jwt-scope.lua. To let agents use a route, switch it to a scope check and add
-- the scope to the MCP scope map.

local token_str = kong.ctx.shared.authenticated_jwt_token
if type(token_str) ~= "string" then
  return
end

local b64_payload = token_str:match("^[^.]+%.([^.]+)%.")
if not b64_payload then
  return
end

b64_payload = b64_payload:gsub("-", "+"):gsub("_", "/")
local pad = (4 - #b64_payload % 4) % 4
b64_payload = b64_payload .. string.rep("=", pad)

local payload_json = ngx.decode_base64(b64_payload)
if payload_json and payload_json:find('"client_id"%s*:') then
  -- RFC 6750 section 3.1: no scope grants access here, so no scope= parameter.
  return kong.response.exit(
    403,
    '{"error":"insufficient_scope","error_description":"This route is not available to OAuth clients"}',
    {
      ["Content-Type"] = "application/json",
      ["WWW-Authenticate"] = 'Bearer error="insufficient_scope"',
    }
  )
end
