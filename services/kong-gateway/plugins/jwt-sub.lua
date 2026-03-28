-- jwt-sub.lua
-- Extracts the `sub` claim from the JWT validated by the kong `jwt` plugin and
-- injects it as the `X-User-Id` request header on the upstream call.
--
-- Why post-function instead of request-transformer:
--   Kong OSS DB-less mode stores `kong.ctx.shared.authenticated_jwt_token` as a
--   raw JWT string (not a decoded table). `request-transformer` cannot reference
--   JWT claim values; this Lua snippet does the decode manually.
--
-- Why no require "cjson":
--   Kong's post-function Lua sandbox explicitly blocks all require() calls —
--   including "cjson" and "cjson.safe" — regardless of the module allowlist.
--   The sandbox BASE_ENV omits `require` entirely (confirmed from Kong 3.7
--   kong-lua-sandbox.lua source). Using require causes HTTP 500 on every request.
--
--   Instead, we extract `sub` with a Lua string pattern. This is safe because:
--     * JWT sub claims are UUIDs or simple strings — no embedded quotes or
--       JSON special characters.
--     * The pattern anchors on the key name and captures a quoted string value.
--     * If the pattern fails to match (malformed payload), the header is simply
--       not set and the request proceeds without X-User-Id.
--
-- This file is the single canonical copy. build.sh inlines its content into
-- every protected route's `post-function` plugin block at render time.

local token_str = kong.ctx.shared.authenticated_jwt_token
if type(token_str) == "string" then
  local b64_payload = token_str:match("^[^.]+%.([^.]+)%.")
  if b64_payload then
    -- Re-pad base64url to standard base64 (JWT strips trailing '=')
    local pad = (4 - #b64_payload % 4) % 4
    b64_payload = b64_payload .. string.rep("=", pad)
    local payload_json = ngx.decode_base64(b64_payload)
    if payload_json then
      -- Extract "sub":"<value>" — safe for UUID/alphanumeric sub values
      local sub = payload_json:match('"sub"%s*:%s*"([^"]+)"')
      if sub then
        kong.service.request.set_header("X-User-Id", sub)
      end
    end
  end
end
