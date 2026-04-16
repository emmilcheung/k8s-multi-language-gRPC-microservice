-- jwt-sub.lua
-- Extracts claims from the JWT validated by the kong `jwt` plugin and
-- injects them as request headers on the upstream call.
--
-- Headers set:
--   * X-User-Id       — the "sub" claim value
--   * X-User-Roles    — comma-separated list of roles from the "roles" claim array
--   * X-User-Id-Sig   — base64(HMAC-SHA256(signing_key, userId .. "|" .. minute))
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
--   Instead, we extract claims with Lua string patterns. This is safe because:
--     * JWT sub/role claims use only alphanumeric, quotes, commas, and brackets.
--     * The pattern anchors on the key name and captures quoted/bracketed values.
--     * If the pattern fails to match (malformed payload), the header is simply
--       not set and the request proceeds without that header.
--
-- SIGNING_KEY_PLACEHOLDER is replaced by build.sh with the actual HMAC key.
-- The key is expected to be a simple hex string (see .env.example / secrets docs).
-- If empty, X-User-Id-Sig is skipped for rollout compatibility.
--
-- This file is the single canonical copy. build.sh inlines its content into
-- every protected route's `post-function` plugin block at render time.

local UINT32 = 4294967296
local UINT32_MASK = UINT32 - 1
local POW2 = { [0] = 1 }
for i = 1, 32 do
  POW2[i] = POW2[i - 1] * 2
end

local SHA256_K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

local function build_nibble_lookup(mode)
  local lookup = {}
  for a = 0, 15 do
    local row = {}
    for b = 0, 15 do
      local result = 0
      local factor = 1
      local left = a
      local right = b
      for _ = 1, 4 do
        local left_bit = left % 2
        local right_bit = right % 2
        if mode == "band" then
          if left_bit == 1 and right_bit == 1 then
            result = result + factor
          end
        elseif left_bit ~= right_bit then
          result = result + factor
        end
        left = math.floor(left / 2)
        right = math.floor(right / 2)
        factor = factor * 2
      end
      row[b] = result
    end
    lookup[a] = row
  end
  return lookup
end

local BAND_NIBBLE = build_nibble_lookup("band")
local BXOR_NIBBLE = build_nibble_lookup("bxor")

local function to_u32(value)
  value = value % UINT32
  if value < 0 then
    value = value + UINT32
  end
  return value
end

local function band_u32(a, b)
  a = to_u32(a)
  b = to_u32(b)
  local result = 0
  local factor = 1
  for _ = 1, 8 do
    local left = a % 16
    local right = b % 16
    result = result + (BAND_NIBBLE[left][right] * factor)
    a = math.floor(a / 16)
    b = math.floor(b / 16)
    factor = factor * 16
  end
  return result
end

local function bxor_pair(a, b)
  a = to_u32(a)
  b = to_u32(b)
  local result = 0
  local factor = 1
  for _ = 1, 8 do
    local left = a % 16
    local right = b % 16
    result = result + (BXOR_NIBBLE[left][right] * factor)
    a = math.floor(a / 16)
    b = math.floor(b / 16)
    factor = factor * 16
  end
  return result
end

local function bxor_u32(...)
  local result = 0
  for i = 1, select("#", ...) do
    result = bxor_pair(result, select(i, ...))
  end
  return result
end

local function bnot_u32(value)
  return UINT32_MASK - to_u32(value)
end

local function rshift_u32(value, shift)
  if shift <= 0 then
    return to_u32(value)
  end
  if shift >= 32 then
    return 0
  end
  return math.floor(to_u32(value) / POW2[shift])
end

local function ror_u32(value, shift)
  value = to_u32(value)
  shift = shift % 32
  if shift == 0 then
    return value
  end
  local lower = value % POW2[shift]
  return to_u32(rshift_u32(value, shift) + (lower * POW2[32 - shift]))
end

local function bxor_byte(left, right)
  local high = BXOR_NIBBLE[math.floor(left / 16)][math.floor(right / 16)]
  local low = BXOR_NIBBLE[left % 16][right % 16]
  return (high * 16) + low
end

local function add_u32(...)
  local sum = 0
  for i = 1, select("#", ...) do
    sum = (sum + to_u32(select(i, ...))) % UINT32
  end
  return sum
end

local function normalize_b64url(value)
  value = value:gsub("-", "+"):gsub("_", "/")
  local pad = (4 - #value % 4) % 4
  return value .. string.rep("=", pad)
end

local function u32_to_bytes(value)
  value = to_u32(value)
  return string.char(
    math.floor(value / 16777216) % 256,
    math.floor(value / 65536) % 256,
    math.floor(value / 256) % 256,
    value % 256
  )
end

local function sha256_raw(message)
  local bit_length = #message * 8
  local high = math.floor(bit_length / UINT32)
  local low = bit_length % UINT32

  message = message .. string.char(0x80)
  message = message .. string.rep(string.char(0), (56 - (#message % 64)) % 64)
  message = message .. u32_to_bytes(high) .. u32_to_bytes(low)

  local hash = {
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  }

  for offset = 1, #message, 64 do
    local words = {}
    for i = 0, 15 do
      local index = offset + (i * 4)
      local b1, b2, b3, b4 = message:byte(index, index + 3)
      words[i + 1] = (b1 * 16777216) + (b2 * 65536) + (b3 * 256) + b4
    end

    for i = 17, 64 do
      local w15 = words[i - 15]
      local w2 = words[i - 2]
      local s0 = bxor_u32(ror_u32(w15, 7), ror_u32(w15, 18), rshift_u32(w15, 3))
      local s1 = bxor_u32(ror_u32(w2, 17), ror_u32(w2, 19), rshift_u32(w2, 10))
      words[i] = add_u32(words[i - 16], s0, words[i - 7], s1)
    end

    local a, b, c, d = hash[1], hash[2], hash[3], hash[4]
    local e, f, g, h = hash[5], hash[6], hash[7], hash[8]

    for i = 1, 64 do
      local s1 = bxor_u32(ror_u32(e, 6), ror_u32(e, 11), ror_u32(e, 25))
      local choice = bxor_u32(band_u32(e, f), band_u32(bnot_u32(e), g))
      local temp1 = add_u32(h, s1, choice, SHA256_K[i], words[i])
      local s0 = bxor_u32(ror_u32(a, 2), ror_u32(a, 13), ror_u32(a, 22))
      local majority = bxor_u32(band_u32(a, b), band_u32(a, c), band_u32(b, c))
      local temp2 = add_u32(s0, majority)

      h = g
      g = f
      f = e
      e = add_u32(d, temp1)
      d = c
      c = b
      b = a
      a = add_u32(temp1, temp2)
    end

    hash[1] = add_u32(hash[1], a)
    hash[2] = add_u32(hash[2], b)
    hash[3] = add_u32(hash[3], c)
    hash[4] = add_u32(hash[4], d)
    hash[5] = add_u32(hash[5], e)
    hash[6] = add_u32(hash[6], f)
    hash[7] = add_u32(hash[7], g)
    hash[8] = add_u32(hash[8], h)
  end

  local output = {}
  for i = 1, #hash do
    output[i] = u32_to_bytes(hash[i])
  end
  return table.concat(output)
end

local function xor_pad(input, value)
  local output = {}
  for i = 1, #input do
    output[i] = string.char(bxor_byte(input:byte(i), value))
  end
  return table.concat(output)
end

local function hmac_sha256_base64(key, message)
  if key == "" then
    return nil
  end

  if #key > 64 then
    key = sha256_raw(key)
  end

  if #key < 64 then
    key = key .. string.rep(string.char(0), 64 - #key)
  end

  local inner = sha256_raw(xor_pad(key, 0x36) .. message)
  local digest = sha256_raw(xor_pad(key, 0x5c) .. inner)
  return ngx.encode_base64(digest)
end

local token_str = kong.ctx.shared.authenticated_jwt_token
if type(token_str) == "string" then
  local b64_payload = token_str:match("^[^.]+%.([^.]+)%.")
  if b64_payload then
    local payload_json = ngx.decode_base64(normalize_b64url(b64_payload))
    if payload_json then
      -- Extract "sub":"<value>" — safe for UUID/alphanumeric sub values
      local sub = payload_json:match('"sub"%s*:%s*"([^"]+)"')
      if sub then
        kong.service.request.set_header("X-User-Id", sub)

        -- Extract "roles":[...] array and flatten into comma-separated list.
        -- Pattern matches strings inside quotes within the array.
        -- Example JWT payload:  "roles":["organizer", "buyer"]
        -- Resulting header:     X-User-Roles: organizer,buyer
        local roles_list = {}
        for role in payload_json:gmatch('"roles"%s*:%s*%[([^%]]+)%]') do
          for r in role:gmatch('"([^"]+)"') do
            table.insert(roles_list, r)
          end
        end
        if #roles_list > 0 then
          kong.service.request.set_header("X-User-Roles", table.concat(roles_list, ","))
        end

        local signing_key = [=[SIGNING_KEY_PLACEHOLDER]=]
        if signing_key ~= "" then
          local current_minute = math.floor(ngx.now() / 60)
          local signature = hmac_sha256_base64(
            signing_key,
            sub .. "|" .. current_minute
          )
          if signature then
            kong.service.request.set_header("X-User-Id-Sig", signature)
          end
        end
      end
    end
  end
end
