# Ticketing MCP Server

Lets an MCP host (Claude Code, or any client that speaks MCP Streamable HTTP and OAuth 2.1) work with the ticketing platform as the signed-in user: search events, place and cancel orders, pay. The host never holds the user's password; it holds a short-lived, audience-bound OAuth token that the user granted on a consent screen and can revoke.

This guide replaces the old stdio-based `mcp-setup.md`, `mcp-structure.md` and `oauth-mcp-status.md`. The stdio package (`packages/ticketing-mcp-server`) still exists and is deprecated; its retirement is planned (see [Planned](#planned-not-in-this-commit)).

Security analysis lives in [`docs/06-security.md`](../06-security.md#mcp-surface-threat-model). This file is the operator and developer guide.

---

## Architecture

```text
MCP host (Claude Code)
   |  1. POST /mcp  (no token)  ->  401 + WWW-Authenticate: resource_metadata=...
   |  2. GET /.well-known/oauth-protected-resource/mcp   -> names the authorization server
   |  3. GET /.well-known/oauth-authorization-server     -> endpoints, S256, registration
   |  4. POST /oauth/clients/register                    -> client_id (RFC 7591)
   |  5. browser: /oauth/authorize (PKCE S256, resource=<origin>/mcp) -> sign in -> consent -> code
   |  6. POST /oauth/token (code + verifier + resource)  -> access token, aud=<origin>/mcp
   v
Kong (:8000)  /mcp, /.well-known/oauth-protected-resource/mcp
   |  no jwt plugin on /mcp; strips X-User-Id / X-User-Roles / X-User-Id-Sig; rate limit per IP
   v
mcp-service  (verifies the MCP-audience token: RS256, iss, aud, exp, client_id)
   |  RFC 8693 token exchange with auth-service (client-authenticated)
   |  -> short-lived token, aud=<origin>/api, same client_id, scope narrowed to the tool
   v
Kong public REST (/api/...)   <- the same scope, waiting-room and rate-limit rules as any other client
```

Three points that explain most of the design:

- **Two audiences.** The token the host holds is for `<origin>/mcp` and is useless against the REST API: Kong's `jwt-scope.lua` refuses an OAuth token whose `aud` is not `<origin>/api` (401 `token audience not accepted`). mcp-service never forwards the host's token; it exchanges it for an API-audience token per call.
- **mcp-service goes through Kong.** It calls the public REST API, not internal gRPC, so scope checks, the waiting room and rate limits apply to agent traffic exactly as to a browser.
- **Stateless.** `POST /mcp` carries one JSON-RPC request and gets one response. `GET /mcp` answers 405 (no server-initiated stream); `DELETE /mcp` is accepted.

### Where the code is

| Concern | Location |
|---|---|
| Resource server, 401 challenge, protected-resource metadata | `services/mcp-service/src/app.ts` |
| Token verification | `services/mcp-service/src/verifier.ts` |
| Token exchange client (cache, timeout) | `services/mcp-service/src/exchange.ts` |
| Tool registry, scope map, error mapping | `services/mcp-service/src/tools.ts`, `scopes.ts`, `upstream.ts` |
| Derived idempotency keys | `services/mcp-service/src/idempotency.ts` |
| Authorization server (authorize, token, exchange, consent, DCR) | `services/auth-service/src/modules/oauth/` |
| Edge routes for `/mcp`, audience rule | `services/kong-gateway/config/kong.base.yml`, `plugins/jwt-scope.lua` |
| Consent page, Settings, Connected apps | `services/client/app/oauth/consent/`, `services/client/app/settings/` |
| Scripted end-to-end proof | `services/client/tests/e2e/mcp-full-flow.spec.ts` |

---

## Tools and scopes

Twelve tools. The scope column is what the token must carry; it comes from the registry in `services/mcp-service/src/scopes.ts` / `tools.ts`.

| Tool | Scope(s) | Purpose |
|---|---|---|
| `search_events` | `tickets:read` | Newest events/tickets, `available` filter, `limit` (max 100). No title search and no paging: the model scans the returned titles. |
| `get_event` | `tickets:read` | One event/ticket by id. |
| `view_seat_availability` | `seating:read` | Seat availability for a seated event. |
| `list_my_orders` | `orders:read` | The caller's orders. |
| `get_order` | `orders:read` | One order. |
| `create_order` | `orders:create` | General-admission order. Idempotent (see below); output carries `replayed`. |
| `create_seated_order` | `orders:create` | Order for specific seats. |
| `cancel_order` | `orders:cancel` | Cancel an order. |
| `get_payment` | `payments:read` | One payment. |
| `list_payment_methods` | `payments:read` | Saved payment methods. |
| `pay_for_order` | `payments:create` | Charge a saved payment method by id (from `list_payment_methods`). Raw card data is never accepted. |
| `pay_for_order_with_default` | `payments:create` + `payments:read` | Pay with the saved default method. |

The authorization server advertises seven scopes: `tickets:read`, `seating:read`, `orders:read`, `orders:create`, `orders:cancel`, `payments:read`, `payments:create`. The consent screen lists them with human labels from `GET /oauth/scopes` and marks the ones that act on the user's behalf as **Sensitive**.

### Behaviours worth knowing

- **Step-up.** A token missing a tool's scope gets `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<held + required>", resource_metadata=...`. A host that supports scope step-up re-runs the consent flow with the union, so the user is never asked for scopes they already granted. The first 401 challenge asks only for the read scopes (`tickets:read seating:read orders:read payments:read`), so write access is requested at the moment it is needed.
- **Idempotent orders.** `create_order` derives an `Idempotency-Key` from `sha256(sub, tool, canonical arguments)`; an identical retry returns the same order with `replayed: true` instead of buying twice. Passing an explicit `idempotencyKey` overrides the derived one. `mcp-full-flow.spec.ts` asserts this against the real stack.
- **Annotations.** Tools that cancel or charge carry the MCP `destructiveHint`, so a host can choose to ask the user before calling them; that confirmation is the host's decision, not the server's.
- **Waiting room.** If the event is behind the queue, the tool fails with `WAITING_ROOM_ACTIVE` and returns the browser URL to join the queue; an agent cannot jump it.
- **Errors are sanitised.** Tool failures return a short code and message, never an upstream stack, token or header. Upstream calls time out after 10 s.

---

## Connect a host

With the stack running (see below):

```bash
claude mcp add --transport http ticketing http://localhost:8000/mcp
```

Then, inside Claude Code, run `/mcp`, pick `ticketing` and choose Authenticate. The host opens a browser; sign in as a normal user and review the consent screen. After Allow Access the host receives the token on its loopback callback and `tools/list` shows twelve tools.

Other hosts need only the URL `http://localhost:8000/mcp`: discovery, registration and PKCE follow from the 401 challenge.

Revoke at any time in the web app under **Settings -> Connected apps**. Revocation stops refresh at once; an MCP access token already issued stays valid until it expires (up to 15 minutes; exchanged API tokens live at most 5 minutes). See the threat model for this accepted window.

---

## Local setup

mcp-service is opt-in: it lives behind the `mcp` compose profile.

1. **Create two related secrets in the git-ignored root `.env`** (the full recipe is the comment block in `.env.example`):
   - `MCP_TOKEN_EXCHANGE_CLIENT_SECRET`: a random value (`openssl rand -base64 32`). mcp-service presents it to auth-service as HTTP Basic client credentials for the token exchange.
   - `MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH`: the lowercase-hex SHA-256 of that value (64 characters). auth-service stores only the hash. Empty means the exchange grant is disabled and every MCP tool call fails; a value that is not 64 hex characters stops auth-service at startup.
2. **Start the stack with the profile:**

   ```bash
   docker compose --profile mcp up -d --build
   ```

   mcp-service refuses to boot without its secret, by design. It listens on host port 3010 for debugging, but hosts must use `http://localhost:8000/mcp` through Kong: calling 3010 directly skips Kong's identity-header stripping and rate limit.
3. **Check discovery:**

   ```bash
   curl -s http://localhost:8000/.well-known/oauth-protected-resource/mcp
   curl -si -X POST http://localhost:8000/mcp   # 401 with a resource_metadata challenge
   ```

### Issuer and public origin must agree

The issuer origin is configured in three places that must be the same value, or tokens are refused:

| Where | Setting |
|---|---|
| auth-service | `OAUTH_ISSUER` (and the derived `OAUTH_API_AUDIENCE` = `<origin>/api`, `OAUTH_MCP_RESOURCE` = `<origin>/mcp`, `OAUTH_RESOURCES`) |
| mcp-service | `OAUTH_ISSUER`, `MCP_RESOURCE` (its token-exchange audience is derived as `<MCP_RESOURCE origin>/api` and must equal auth-service's `OAUTH_API_AUDIENCE`) |
| Kong | `KONG_OAUTH_ISSUER` (builds the `<origin>/api` audience the REST rule checks) |

In Kubernetes the Helm value `global.publicOrigin` derives the auth-service set; the deploy pipeline must set `KONG_OAUTH_ISSUER` to the same origin. Local compose uses `http://localhost:8000` for all of them. `KONG_OAUTH_ISSUER` is required for dev, staging and prod; only local and minikube have a default. See `services/kong-gateway/README.md`.

---

## Verify it

### Scripted (no Claude Code needed)

`services/client/tests/e2e/mcp-full-flow.spec.ts` plays the host's part against a live stack through Kong, with the login and consent in a real browser page: discovery, dynamic registration, authorization code + PKCE with `resource`, `initialize`, `tools/list` (12), `search_events`, `create_order` twice (second `replayed: true`), `pay_for_order_with_default`, plus three negative edges (no token -> 401 with `resource_metadata`; MCP-audience token on REST -> 401; token without `orders:create` -> step-up 403). Run it like the other specs: stack up with `--profile mcp`, `pnpm dev --port 4000` in `services/client`, then `npx playwright test mcp-full-flow.spec.ts`. The payment step needs a saved card; with `STRIPE_SECRET_KEY=test_mock` the payment service runs in its deterministic mock mode. If the card cannot be saved, the step is skipped with a named reason rather than passing silently.

### Manual run with a real host (M-2) — owner step, not yet performed

This needs an interactive terminal and a browser, so it is written down and has not been run. Procedure:

1. Start the stack with the `mcp` profile and a valid `.env` (above). Run `claude --version` and note it.
2. `claude mcp add --transport http ticketing http://localhost:8000/mcp`
3. Start `claude`, run `/mcp`, select `ticketing`, choose Authenticate.
4. In the browser: sign in (or sign up) as a normal user. Expect the consent page "Allow access?" naming the host, listing the requested permissions with **Sensitive** badges on the ones that act on your behalf. Click Allow Access. Expect the host to report it is connected.
5. Ask the host: "List the available events", then "Create an order for the first available ticket", then repeat the same request (expect the same order, not a second one).
6. Open **Settings -> Connected apps**, confirm the host is listed, revoke it, and confirm the next `/mcp` call prompts for authentication again once the token expires.
7. **Record:** the Claude Code version; the MCP protocol version negotiated at `initialize` (visible in `claude --debug` output, or run the scripted spec, which records it); which tools were callable; any step where the host asked for re-authentication.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401` with `token audience not accepted` on a REST call | An MCP-audience token (`aud` = `<origin>/mcp`) was sent to `/api`. Expected; hosts must talk to `/mcp`. If a tool call fails this way, check that mcp-service's exchange is working (next rows). |
| `401 invalid_token` from `/mcp` with a fresh token | `iss`, `aud` or signature mismatch. `OAUTH_ISSUER` / `MCP_RESOURCE` in mcp-service must equal the origin in the token; keys must match the JWKS Kong and auth-service use. |
| `403 insufficient_scope` naming a scope | The token lacks the tool's scope. A host with step-up support re-prompts consent; otherwise remove the app under Settings -> Connected apps and connect again, approving the extra scope. |
| Every tool call fails with a token-exchange error | Exchange disabled or mismatched secret: `MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH` is empty, or is not the SHA-256 of `MCP_TOKEN_EXCHANGE_CLIENT_SECRET`. Recompute the hash and recreate auth-service and mcp-service. |
| auth-service exits at startup mentioning the hash | `MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH` is set but is not 64 lowercase hex characters. |
| mcp-service exits at startup | A required setting is missing (`MCP_RESOURCE`, `OAUTH_ISSUER`, `AUTH_JWKS_URL`, `TOKEN_EXCHANGE_URL`, `KONG_INTERNAL_URL`, `PUBLIC_WEB_URL`, `TOKEN_EXCHANGE_CLIENT_SECRET`). It validates config before serving. |
| `429` from `/mcp` | Per-IP limit (`RATE_LIMIT_MCP_PER_MINUTE`). Everyone behind one NAT shares it. |
| `WAITING_ROOM_ACTIVE` from `create_order` | The event is queued; open the URL in the result in a browser. |
| `GET /mcp` returns 405 | By design; the server is stateless request/response. |
| Consent page loads but Allow does nothing | The page is not hydrated yet; wait for the page to settle and click again. |

---

## Planned (not in this commit)

These are tracked in the MCP platform upgrade and are **not** implemented here; nothing above depends on them.

- **Client ID Metadata Documents (CIMD)** in the authorization server, behind `OAUTH_CIMD_ENABLED` (WS-I). Until it lands, hosts register with dynamic client registration.
- **Retiring the stdio package and making `aud` mandatory** on OAuth tokens at the edge (WS-N). Until then the `.mcp.json` stdio entry and `packages/ticketing-mcp-server` remain; do not use them for new work. Tokens without an `aud` claim are tolerated by the REST audience rule.

## History

The first MCP integration (April 2026) was a local stdio server that ran its own PKCE login and stored tokens on disk. Its setup notes, structure notes and status log were removed in favour of this guide. The Kong scope enforcement (`jwt-scope.lua`), dynamic client registration and consent flow it introduced are still the foundation of the current design.
