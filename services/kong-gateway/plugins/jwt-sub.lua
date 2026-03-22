-- jwt-sub.lua
-- Extracts the `sub` claim from the JWT validated by the kong `jwt` plugin and
-- injects it as the `X-User-Id` request header on the upstream call.
--
-- Why post-function instead of request-transformer:
--   Kong OSS DB-less mode stores `kong.ctx.shared.authenticated_jwt_token` as a
--   raw JWT string (not a decoded table). `request-transformer` cannot reference
--   JWT claim values; this Lua snippet does the decode manually.
--
-- This file is the single canonical copy.  build.sh inlines its content into
-- every protected route's `post-function` plugin block at render time.

local token_str = kong.ctx.shared.authenticated_jwt_token
if type(token_str) == "string" then
  local b64_payload = token_str:match("^[^.]+%.([^.]+)%.")
  if b64_payload then
    local pad = (4 - #b64_payload % 4) % 4
    b64_payload = b64_payload .. string.rep("=", pad)
    local payload_json = ngx.decode_base64(b64_payload)
    if payload_json then
      local sub = payload_json:match('"sub"%s*:%s*"([^"]+)"')
      if sub then
        kong.service.request.set_header("X-User-Id", sub)
      end
    end
  end
end
