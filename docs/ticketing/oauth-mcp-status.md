# Agent-Native OAuth2 + MCP — Implementation Status

**Feature:** Make the ticketing platform agent-native via OAuth2 Authorization Code + PKCE and a client-side MCP server  
**Branch:** `feat/agent-native-oauth-mcp`  
**Started:** 2026-04-13  
**Last Updated:** 2026-04-13  

---

## Summary

Enables AI agents (Claude Code, etc.) to interact with the ticketing platform as the authenticated user, without ever holding user credentials. The MCP server runs on the user's machine, holds OAuth2 tokens in the OS keychain, and calls Kong with a standard Bearer JWT. Kong, auth-service, and all downstream services require zero breaking changes.

---

## Architecture Decisions (Manager Log)

| Decision | Rationale |
|---|---|
| Auto-approve for `ticketing-mcp` (no consent UI) | First-party client; simplifies P0 scope |
| Reuse existing RS256 JWT format, add `scope` + `client_id` claims | Kong's jwt plugin validates identically; jwt-sub.lua still extracts sub → X-User-Id |
| Bearer token in Kong via `header_names: [Authorization]` | Additive to cookie support; zero breaking change for existing browser flow |
| OAuth refresh token piggybacks existing RefreshTokenService | No new token storage primitives; scope metadata stored alongside in separate Redis key |
| Scope enforcement at Kong (Lua), not in services | Services need zero changes; enforcement at gateway boundary |
| MCP server as standalone npm package in `packages/` | Independently installable; users run it outside the monorepo |

---

## Contracts (Manager-Defined)

### OAuth2 Scopes
```
tickets:read | orders:read | orders:create | orders:cancel
payments:read | payments:create | venues:read
seating:read | seating:hold
```

### JWT additions (same RS256 key, same `iss`)
```json
{
  "sub": "<userId UUID>",
  "email": "<email>",
  "jti": "<uuid>",
  "iss": "auth-service",
  "scope": "tickets:read orders:read orders:create",
  "client_id": "ticketing-mcp",
  "iat": ..., "exp": ...
}
```

### New endpoints (auth-service)
```
GET  /oauth/authorize    → consent/auto-approve → redirect with ?code=
POST /oauth/token        → { access_token, refresh_token, token_type, expires_in, scope }
POST /oauth/revoke       → 200 OK
GET  /oauth/clients      → list OAuth sessions for current user (JWT required)
DELETE /oauth/clients/:clientId → revoke all sessions for client (JWT required)
```

### Redis keys (new)
```
auth-service:oauth:code:<code>          → { clientId, userId, scope, codeChallenge, codeChallengeMethod, redirectUri, createdAt }  TTL 600s
auth-service:oauth:session-scope:<sessionId>  → { scope, clientId }  TTL = refresh token TTL
```

### Kong changes (additive only)
```yaml
# Add to every jwt plugin block:
header_names: [Authorization]

# New routes in auth-service service block:
oauth-public:  GET|POST /oauth/authorize, /oauth/token, /oauth/revoke  (rate-limited, no JWT)
oauth-clients: GET|DELETE /oauth/clients, /oauth/clients/*              (JWT required)
```

### Static OAuth client (ticketing-mcp)
```
clientId:           ticketing-mcp
redirectUri:        http://127.0.0.1:19836/callback
pkceRequired:       true (S256 only)
accessTokenTTL:     900s (15 min, matches existing JWT_EXPIRY)
refreshTokenTTL:    86400s (24h, shorter than browser's 7d)
allowedScopes:      all scopes above
```

---

## Workstream Status

### Batch 1 — Foundation (parallel)

| WS | Name | Files | Status | Notes |
|---|---|---|---|---|
| WS1-A | OAuth client registry + PKCE utils | `modules/oauth/oauth-clients.config.ts`, `modules/oauth/pkce.util.ts` | ✅ Done | tsc clean |
| WS1-B | OAuth code store service | `modules/oauth/oauth-code-store.service.ts` | ✅ Done | tsc clean |
| WS2 | Kong Bearer + OAuth routes | `kong.base.yml` | ✅ Done | 11 jwt blocks updated; oauth-public + oauth-clients routes added |

### Batch 2 — OAuth Module (sequential, after Batch 1)

| WS | Name | Files | Status | Notes |
|---|---|---|---|---|
| WS1-C | OAuth NestJS module | `oauth.service.ts`, `oauth.controller.ts`, `oauth.module.ts`, `oauth.dto.ts`; modify `auth.service.ts`, `auth.module.ts`, `app.module.ts` | ✅ Done | tsc + ESLint clean |

### Batch 3 — MCP Server (after WS1-C)

| WS | Name | Files | Status | Notes |
|---|---|---|---|---|
| WS3 | `@ticketing/mcp-server` package | `packages/ticketing-mcp-server/` (new) | ✅ Done | tsc clean; 11 MCP tools |

---

## Verification Checklist

### Per-workstream gates
- [ ] WS1-A: `pnpm tsc --noEmit` in auth-service passes
- [ ] WS1-B: `pnpm tsc --noEmit` in auth-service passes
- [ ] WS2: Kong YAML structurally valid (no indentation errors)
- [ ] WS1-C: `pnpm tsc --noEmit` + `pnpm lint` in auth-service passes; existing auth tests still pass
- [ ] WS3: `pnpm tsc --noEmit` in mcp-server package passes

### Final gate (before PR)
- [ ] Existing web E2E: 18/18 Playwright tests still passing
- [ ] auth-service integration tests: all passing
- [ ] No new secrets in any committed file

---

## Phase 2 — Browser Login Flow ✅ COMPLETE (2026-04-14)

Implemented on branch `feature/oauth-mcp-phase2`. PR #44.

| Item | Status | Notes |
| --- | --- | --- |
| Smooth browser OAuth round-trip | ✅ Done | auth-service redirects to absolute Next.js URL with full `?next=` authorize URL; signin page forwards `?next` through hidden form field; `isSafeRedirect()` guard prevents open redirect |
| Polished callback pages | ✅ Done | Dark-theme card with SVG icons for success/error |
| Terminal UX | ✅ Done | Full authorize URL printed; copy-paste fallback instructions |

## Phase 2 — Full OAuth Feature Set ✅ COMPLETE (2026-04-14)

Implemented on branch `feature/oauth-mcp-phase2`.

| Item | Status | Files |
| --- | --- | --- |
| Kong scope enforcement | ✅ Done | `plugins/jwt-scope.lua`, `build.sh` (SCOPE_CHECK_LUA handler), `kong.base.yml` (orders + payments routes split for per-scope pre-function) |
| Dynamic client registration | ✅ Done | `oauth/dynamic-client.service.ts`, `POST /oauth/clients/register` (RFC 7591), Kong `oauth-public` route |
| Consent screen UI | ✅ Done | `oauth-consent-store.service.ts`, `GET`/`POST /oauth/consent/:requestId`, Next.js `/oauth/consent` page with scope labels + destructive warning |
| `.claude/mcp.json` snippet | ✅ Done | `.claude/mcp.json` (project-level Claude Code config), `docs/ticketing/mcp-setup.md` |

### How consent works for third-party clients

```text
GET /oauth/authorize (dynamic client_id, user authenticated)
  → auth-service stores PendingConsent in Redis (TTL 10 min) → request_id
  → 302 to Next.js /oauth/consent?request_id=<id>
  → Next.js fetches GET /oauth/consent/<id> (public) → renders scope card
  → user clicks Allow → POST /oauth/consent/<id> (JWT cookie validated by Kong, X-User-Id injected)
  → auth-service issues code → returns redirectUrl
  → Next.js client-side redirects browser to callback
```

First-party clients (`ticketing-mcp`) are auto-approved without the consent step.

---

## Recovery Point

If token limit hit: resume from the **last completed batch** row above.  
Check which workstream files exist on disk to determine progress.  
Next action is always: "Dispatch the next pending batch."

---

## Files Modified / Created

### auth-service
- `src/modules/oauth/oauth-clients.config.ts` [NEW — WS1-A]
- `src/modules/oauth/pkce.util.ts` [NEW — WS1-A]
- `src/modules/oauth/oauth-code-store.service.ts` [NEW — WS1-B]
- `src/modules/oauth/oauth.dto.ts` [NEW — WS1-C]
- `src/modules/oauth/oauth.service.ts` [NEW — WS1-C]
- `src/modules/oauth/oauth.controller.ts` [NEW — WS1-C]
- `src/modules/oauth/oauth.module.ts` [NEW — WS1-C]
- `src/modules/auth/auth.service.ts` [MODIFY — WS1-C: add issueTokenWithScopes + extend JwtPayload]
- `src/modules/auth/auth.module.ts` [MODIFY — WS1-C: add exports]
- `src/app.module.ts` [MODIFY — WS1-C: add OAuthModule import]

### kong-gateway
- `config/kong.base.yml` [MODIFY — WS2: header_names + oauth routes]

### packages (new top-level dir)
- `packages/ticketing-mcp-server/` [NEW — WS3]
