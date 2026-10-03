-- jwt-scope.lua
-- OAuth scope gate for routes that admit OAuth access tokens (D9, C-10).
--
-- Runs as the FIRST post-function access entry, after the jwt plugin has
-- verified the token, and reads that verified token from
-- kong.ctx.shared.authenticated_jwt_token. A token sent as the `token` cookie
-- is therefore checked exactly like an Authorization: Bearer one (F11).
--
--   no `scope` and no `client_id` -> browser session / anonymous token -> pass
--   otherwise                     -> OAuth access token -> must hold
--                                    SCOPE_PLACEHOLDER, else 403. A `client_id`
--                                    token without `scope` is refused.
--
-- REST audience rule (C-10): an OAuth token (has `client_id`) that carries an
-- `aud` not containing API_AUDIENCE_PLACEHOLDER is refused 401 before the scope
-- check. This is what keeps an MCP-audience token (aud <origin>/mcp) out of REST
-- routes; only the exchanged API-audience token passes. A token with no `aud` is
-- tolerated until WS-N makes `aud` mandatory, and each one that passes is logged
-- at notice level. Browser tokens have no client_id and are never subject to it.
--
-- Why no require "cjson": Kong's untrusted Lua sandbox blocks require() (only
-- resty.openssl.hmac is allow-listed, for queue-gate.lua). Claims are read
-- with string patterns; safe because the token is already verified and scope
-- values use only letters and colons.
--
-- SCOPE_PLACEHOLDER is replaced by build.sh with the required scope (e.g.
-- "orders:read"). build.sh requires every jwt route to carry exactly one of
-- this check or oauth-deny.lua, inside its post-function.

local scope_required = "SCOPE_PLACEHOLDER"
local api_audience = "API_AUDIENCE_PLACEHOLDER"

local token_str = kong.ctx.shared.authenticated_jwt_token
if type(token_str) ~= "string" then
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

-- REST audience rule. `aud` is a JSON string or an array of strings; match the
-- audience as a whole quoted value inside that claim only.
if payload_json:find('"client_id"%s*:') then
  local aud_at = payload_json:match('"aud"%s*:%s*()')
  if aud_at then
    local aud_value
    if payload_json:sub(aud_at, aud_at) == "[" then
      aud_value = payload_json:match("^%[(.-)%]", aud_at)
    else
      aud_value = payload_json:match('^("[^"]*")', aud_at)
    end
    if not (aud_value and aud_value:find('"' .. api_audience .. '"', 1, true)) then
      return kong.response.exit(
        401,
        '{"error":"invalid_token","error_description":"token audience not accepted"}',
        {
          ["Content-Type"] = "application/json",
          ["WWW-Authenticate"] = 'Bearer error="invalid_token", error_description="token audience not accepted"',
        }
      )
    end
  else
    -- Tolerated for now, but never silently: this line going quiet is the evidence
    -- that no OAuth client still sends an audience-less token, i.e. that making `aud`
    -- mandatory is safe. Fixed text only; the token is never logged.
    kong.log.notice("oauth token without aud accepted on a REST route (aud becomes mandatory later)")
  end
end

-- Extract the `scope` claim value (space-separated string).
local scope = payload_json:match('"scope"%s*:%s*"([^"]+)"')
if not scope then
  if not payload_json:find('"client_id"%s*:') then
    -- Browser session or anonymous token: not an OAuth grant, nothing to gate.
    return
  end
  -- OAuth token with no scope claim grants nothing: fail closed.
  scope = ""
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
  -- RFC 6750 section 3.1 insufficient_scope response.
  kong.response.exit(
    403,
    '{"error":"insufficient_scope","error_description":"The access token lacks the required scope: ' .. scope_required .. '"}',
    {
      ["Content-Type"] = "application/json",
      ["WWW-Authenticate"] = 'Bearer error="insufficient_scope", scope="' .. scope_required .. '"',
    }
  )
end
