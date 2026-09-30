-- oauth-deny.lua
-- Refuses OAuth access tokens on a route that has no OAuth scope (D9, C-10).
--
-- Runs as the FIRST post-function access entry, after the jwt plugin has
-- verified the token, and reads that verified token from
-- kong.ctx.shared.authenticated_jwt_token, so header and cookie are covered.
-- A token with a `client_id` claim was minted for an OAuth client (C-1
-- invariant) and gets 403 insufficient_scope. Browser session tokens and the
-- anonymous GraphQL token carry no `client_id` and pass.
--
-- build.sh requires every jwt route to carry exactly one of this file or
-- jwt-scope.lua. To let agents use a route, switch it to a scope check and add
-- the scope to the MCP scope map (spec C-7).

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
  return kong.response.exit(403, {
    error = "insufficient_scope",
    error_description = "OAuth access tokens are not accepted on this route",
  })
end
