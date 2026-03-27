-- jwt-sub.lua
-- Extracts the `sub` claim from the JWT validated by the kong `jwt` plugin and
-- injects it as the `X-User-Id` request header on the upstream call.
--
-- Why post-function instead of request-transformer:
--   Kong OSS DB-less mode stores `kong.ctx.shared.authenticated_jwt_token` as a
--   raw JWT string (not a decoded table). `request-transformer` cannot reference
--   JWT claim values; this Lua snippet does the decode manually.
--
-- Why cjson.safe instead of regex (S-19):
--   Regex extraction is fragile — it breaks on unusual whitespace, Unicode
--   escapes, or reordered claims.  cjson.safe.decode is the correct approach:
--   it parses the JSON payload fully and returns a native Lua table, so claim
--   lookup is O(1) and immune to injection via crafted claim values.
--
-- This file is the single canonical copy.  build.sh inlines its content into
-- every protected route's `post-function` plugin block at render time.

local cjson_safe = require "cjson.safe"

local token_str = kong.ctx.shared.authenticated_jwt_token
if type(token_str) == "string" then
  local b64_payload = token_str:match("^[^.]+%.([^.]+)%.")
  if b64_payload then
    local pad = (4 - #b64_payload % 4) % 4
    b64_payload = b64_payload .. string.rep("=", pad)
    local payload_json = ngx.decode_base64(b64_payload)
    if payload_json then
      local payload, err = cjson_safe.decode(payload_json)
      if payload and not err and type(payload.sub) == "string" then
        kong.service.request.set_header("X-User-Id", payload.sub)
      end
    end
  end
end
