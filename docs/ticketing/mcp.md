# Ticketing MCP Server

Lets an MCP host (Claude Code, or any client that speaks MCP Streamable HTTP and OAuth 2.1) work with the ticketing platform as the signed-in user: search events, place and cancel orders, pay. The host never holds the user's password; it holds a short-lived, audience-bound OAuth token that the user granted on a consent screen and can revoke.

This guide replaces the old stdio-based `mcp-setup.md`, `mcp-structure.md` and `oauth-mcp-status.md`. The stdio package (`packages/ticketing-mcp-server`) still exists and is deprecated; its retirement is planned (see [Planned](#planned-not-in-this-commit)). Client ID Metadata Documents are built; see [Client ID Metadata Documents](#client-id-metadata-documents-cimd).

Security analysis lives in [`docs/06-security.md`](../06-security.md#mcp-surface-threat-model). This file is the operator and developer guide.

---

## Architecture

```text
MCP host (Claude Code)
   |  1. POST /mcp  (no token)  ->  401 + WWW-Authenticate: resource_metadata=...
   |  2. GET /.well-known/oauth-protected-resource/mcp   -> names the authorization server
   |  3. GET /.well-known/oauth-authorization-server     -> endpoints, S256, registration
   |  4. POST /oauth/clients/register                    -> client_id (RFC 7591), or skip it:
   |     a host may use an https URL it hosts as client_id (CIMD, only if enabled)
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
- **Stateless.** `POST /mcp` carries one JSON-RPC request and gets one response. `GET /mcp` and `DELETE /mcp` both answer `405` with JSON-RPC error `-32000 Method not allowed.` once the caller is authenticated, and `401` without a token. That is the behaviour of the MCP SDK's transport in stateless mode at the pinned versions (`@modelcontextprotocol/server` 2.2.0 and `@modelcontextprotocol/node` 2.1.0, `services/mcp-service/package.json:21-22`), not a rule this service codes itself; the route handler is `services/mcp-service/src/app.ts:149`. The E2E spec asserts both 405s, so an SDK upgrade that changes this fails loudly. There is no server-initiated stream and no session to delete.

### Where the code is

| Concern | Location |
|---|---|
| Resource server, 401 challenge, protected-resource metadata | `services/mcp-service/src/app.ts` |
| Token verification | `services/mcp-service/src/verifier.ts` |
| Token exchange client (cache, timeout) | `services/mcp-service/src/exchange.ts` |
| Tool registry, scope map, error mapping | `services/mcp-service/src/tools.ts`, `scopes.ts`, `upstream.ts` |
| Derived idempotency keys | `services/mcp-service/src/idempotency.ts` |
| Authorization server (authorize, token, exchange, consent, DCR, CIMD) | `services/auth-service/src/modules/oauth/` (CIMD: `cimd-fetcher.ts`, `cimd-client.service.ts`, `cimd-document.ts`) |
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

The authorization server advertises nine scopes (`scopes_supported`, `oauth-metadata.controller.ts:38`; registry in `oauth-scopes.ts`): the seven above, `tickets:read`, `seating:read`, `orders:read`, `orders:create`, `orders:cancel`, `payments:read`, `payments:create`, plus `venues:read` and `seating:hold`, which stay registered (and are in the dynamic-registration allow list, `dynamic-client.service.ts:55-61`) but are used by no tool. A client may be granted them; nothing happens with them. The consent screen lists them with human labels from `GET /oauth/scopes` and marks the ones that act on the user's behalf as **Sensitive**.

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

**Consent.** A host that registers itself (dynamic client registration) or identifies itself by a metadata-document URL always sees the consent screen. Consent is skipped only for a client whose entry sets `isFirstParty: true` (`oauth.service.ts:263-265`); dynamic and CIMD clients are hard-coded `false`, and the only static client (`ticketing-mcp`, `oauth-clients.config.ts:28-37`) does not set it, so no client skips consent today. The Allow and Deny buttons stay disabled until the page has hydrated, so a click is never silently lost.

**Revoke.** In the web app under **Settings -> Connected apps** (`services/client/app/settings/connected-apps.ts:64-71`). It calls `DELETE /oauth/clients?client_id=<id>` (`oauth.controller.ts:130-148`; the older `/oauth/clients/:clientId` form stays for opaque ids; 204 on success, signed-in user only). Revocation deletes, for that user and that client, the session-scope marker and the refresh sessions (`oauth.service.ts:808-825`), so the host cannot obtain new access tokens. It leaves the client registration in place, and there is no consent history to remove (the consent store only holds a pending consent for 10 minutes). A token already issued stays valid until it expires: access tokens live 15 minutes, exchanged API tokens at most 5.

**Refresh tokens are sliding.** A refresh rotates the token and re-stores two records: the session record (TTL `REFRESH_TOKEN_TTL_SECONDS`, compose default 604800 s) and the OAuth session-scope marker (86400 s for the static, dynamic and CIMD clients) (`refresh-token.service.ts:181-187`, `oauth.service.ts:732-739`). A refresh token left unused for 24 hours stops working; one used at least once every 24 hours keeps working indefinitely until you revoke the app. Rotation has no reuse detection and is not atomic, so two simultaneous refreshes with one token can both succeed. These are accepted residuals, listed in the threat model.

### Client ID Metadata Documents (CIMD)

Instead of registering, a host can use an `https` URL it controls as its `client_id`; the URL serves a small JSON document describing the client. Auth-service fetches and validates it when the host starts authorization.

- **Flag.** `OAUTH_CIMD_ENABLED`, default `false` (`oauth-config.ts:36`, `services/auth-service/.env.example:55`). It is `true` in `docker-compose.yml:319` and `infra/helm/values-local.yaml:49` only. With it off a URL `client_id` is an unknown client, nothing is fetched, and the authorization-server metadata does not advertise support. With it on, the metadata carries `client_id_metadata_document_supported: true` (`oauth-metadata.controller.ts:42`).
- **The URL.** `https`, at most 512 characters, a DNS host name (no IP literal, no single-label host, no internal suffix such as `.internal`, `.local`, `.svc`), port 443 only, a non-root path without dot segments, no query, fragment or userinfo (`cimd-fetcher.ts:188-234`).
- **The document.** HTTP 200, a JSON content type, at most 5 KB, no redirects, fetched within 3 s. It must be a JSON object whose `client_id` equals the URL exactly, with 1 to 10 `redirect_uris` (each `https`, or `http` on `localhost` / `127.0.0.1`, no fragment, no userinfo), a valid `client_name` (at most 100 characters, no control or formatting characters), and `token_endpoint_auth_method` absent or `none` (`cimd-document.ts:27-118`). The resulting client is public, never first-party, with 15 minute access and 24 hour refresh lifetimes.
- **Cache.** The document is cached in Redis for its `Cache-Control: max-age`, at least 60 s and at most 24 h (default 5 minutes; `no-store` and `no-cache` get 60 s); a failed validation is cached for 60 s (`cimd-client.service.ts:21-26,38-46`). A changed or removed document therefore takes effect only after its cache entry expires, up to 24 hours, and there is no purge.
- **Errors.** A document or URL that is refused gives 400 `invalid_client` with a generic message. A temporary failure (timeout, connection failure, DNS unavailable, or too many fetches in flight) gives 503 `temporarily_unavailable` with `Retry-After` (60 s, or 5 s when busy), so a client that is refreshing retries instead of giving up (`oauth-unavailable.ts`, `oauth.service.ts:56-60`).
- **What the user sees.** The consent page shows the document host ("App identity document hosted at ..."), where the user is sent after allowing ("After you allow, you are sent to ...", reading "an app on this device" for a loopback redirect), and an amber caution when the two hosts differ (`services/client/app/oauth/consent/page.tsx:165-197`). The client id is shown on its own line under the app details, inside the card (`page.tsx:202-209`). Settings -> Connected apps lists the client by its URL.
- **Dynamic registration stays.** It is unchanged for integrators except for the shared validation (redirect URIs: `https`, or `http` on loopback hosts only, no fragment, no userinfo, refused as `invalid_redirect_uri`, or as `invalid_client_metadata` when the DTO's URL check rejects the value first, for example `https://:@a.example/cb`, both 400; `client_name` at most 100 characters without control or formatting characters; `application_type` `native` or `web`), and it is marked deprecated in code (`oauth.service.ts:913`). Claude Code still registers this way.
- **Running it in a cluster needs an owner-approved egress rule.** CIMD makes auth-service open outbound HTTPS to hosts chosen by callers. The auth-service chart's NetworkPolicy allows egress to DNS, PostgreSQL, Redis and Kafka only (`infra/helm/charts/auth-service/templates/networkpolicy.yaml`), and no CIMD egress policy exists. Before enabling the flag outside local, someone must write and owner-review a rule for TCP 443 to the public internet excluding private ranges, plus DNS. Until then staging and prod keep the flag off. The fetcher also refuses private and special-purpose addresses itself (see the threat model), but that is defence in depth, not a substitute for the network rule.
- **What has not been verified.** The fetch of a real public document on a running stack: the E2E spec deliberately contacts no external host. It asserts the metadata flag on the compose stack and that URL client ids naming `169.254.169.254` and a `.internal` host are refused with 400 `invalid_client`, not a 5xx.

---

## Local setup

mcp-service is opt-in: it lives behind the `mcp` compose profile.

1. **Create two related secrets in the git-ignored root `.env`** (the full recipe is the comment block in `.env.example`):
   - `MCP_TOKEN_EXCHANGE_CLIENT_SECRET`: a random value (`openssl rand -base64 32`). mcp-service presents it to auth-service as HTTP Basic client credentials for the token exchange.
   - `MCP_TOKEN_EXCHANGE_CLIENT_SECRET_HASH`: the lowercase-hex SHA-256 of that value (64 characters), for example `printf %s "$SECRET" | sha256sum | cut -d' ' -f1`. auth-service stores only the hash. Empty means the exchange grant is disabled and every MCP tool call fails; a value that is not 64 hex characters stops auth-service at startup.

   Those two, plus the `mcp` profile in step 2, are everything a working local run needs beyond the normal `.env` (RSA key pair, signing keys). Nothing else has to be set: `docker-compose.yml` already gives auth-service `OAUTH_ISSUER_ENABLED: "true"` and the issuer, resource and audience origins (`docker-compose.yml:311-316`), and gives mcp-service its issuer, JWKS and exchange URLs (`docker-compose.yml:352-362`). `OAUTH_ISSUER_ENABLED` matters because tokens carry `iss` only when it is on, and mcp-service rejects tokens without the expected issuer; outside compose (Helm, other environments) it must be set explicitly.
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

`services/client/tests/e2e/mcp-full-flow.spec.ts` plays the host's part against a live stack through Kong, with the login and consent in a real browser page: discovery, dynamic registration, authorization code + PKCE with `resource`, `initialize`, `tools/list` (12), `search_events`, `create_order` twice (second `replayed: true`), `pay_for_order_with_default`, plus three negative edges (no token -> 401 with `resource_metadata`; MCP-audience token on REST -> 401 `token audience not accepted`; token without `orders:create` -> step-up 403). It also asserts that authenticated `GET /mcp` and `DELETE /mcp` are 405, that the metadata advertises CIMD on the compose stack, and that two URL client ids naming internal addresses are refused as `invalid_client`. The spec records the protocol version negotiated at `initialize` as a Playwright annotation named `mcp-protocol-version` (visible in the HTML report and the test's annotations) and asserts only that it is a `YYYY-MM-DD` string; the spec itself offers `2025-11-25`. Run it like the other specs: stack up with `--profile mcp` and the two exchange variables, `pnpm dev --port 4000` in `services/client`, then `npx playwright test mcp-full-flow.spec.ts`. Without mcp-service the spec fails immediately naming the missing profile. CI's `e2e` job starts mcp-service with an ephemeral exchange secret, so the spec runs there with the rest of the suite.

The payment step needs a saved card, registered through Settings with the same Stripe mock `ticketing.spec.ts` uses. It asserts payment status `completed` and then polls `get_order` until the order is `complete`. It relies on payment-service running in `STRIPE_SECRET_KEY=test_mock` mode, which the spec cannot observe (it is a backend setting); a non-mock backend fails the status assertion rather than passing. It is skipped, with the reason in the run summary, only when card registration answers 5xx or 404, as in `ticketing.spec.ts`.

### Manual run with a real host (M-2)

Run once on 2026-10-02 against a compose stack (result below the procedure). Procedure:

1. Start the stack with the `mcp` profile and a valid `.env` (above). Run `claude --version` and note it.
2. `claude mcp add --transport http ticketing http://localhost:8000/mcp`
3. Start `claude`, run `/mcp`, select `ticketing`, choose Authenticate.
4. In the browser: sign in (or sign up) as a normal user. Expect the consent page "Allow access?" naming the host, listing the requested permissions with **Sensitive** badges on the ones that act on your behalf. Click Allow Access. Expect the host to report it is connected.
5. Ask the host: "List the available events", then "Create an order for the first available ticket", then repeat the same request (expect the same order, not a second one).
6. Open **Settings -> Connected apps**, confirm the host is listed, revoke it, and confirm the next `/mcp` call prompts for authentication again once the token expires.
7. **Record:** the Claude Code version; the MCP protocol version negotiated at `initialize` (visible in `claude --debug` output, or run the scripted spec, which records it); which tools were callable; any step where the host asked for re-authentication.

**Result, 2026-10-02 (Claude Code 2.1.285, compose stack with the `mcp` profile, `OAUTH_CIMD_ENABLED=true`):**

- The host found the server from the 401 challenge and, because the metadata advertises `client_id_metadata_document_supported`, identified itself with the URL client id `https://claude.ai/oauth/claude-code-client-metadata` instead of registering dynamically. Auth-service fetched that document (`oauth.cimd.fetched`, host `claude.ai`). With the flag off, the host has to fall back to dynamic registration; that path was not run with a real host.
- Consent page: "Claude Code", "App identity document hosted at `claude.ai`", "an app on this device", seven permissions with three **Sensitive** badges. After Allow Access the host reported "Authentication successful. Connected to ticketing."
- Twelve tools were visible. `search_events` listed the seeded events; `create_order` returned a new order with `replayed: false`; the same call again returned the same order id with `replayed: true`; `list_my_orders` showed one order. Payment tools were not called (no saved card).
- Revoke under Settings -> Connected apps (`DELETE /oauth/clients?client_id=` -> 204) removed the app from the list. Earlier in the same run, revoking the host's entry under Security & sessions also removed it from Connected apps; the host's access token kept working until it expired (15 minutes), then the next tool call failed with "needs you to sign in again" and `/mcp` offered Authenticate. A second sign-in (through the sign-in page, then consent) reconnected it.
- Not recorded: the negotiated MCP protocol version (it is not in the host's debug log or the service logs; the scripted spec asserts its shape). Not run: the wait for token expiry after the Connected-apps revoke, the step-up path with a real host, and payment.

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
| `GET /mcp` or `DELETE /mcp` returns 405 | By design; the SDK transport is stateless request/response. |
| `503 temporarily_unavailable` from `/oauth/authorize` for a URL client id | The metadata document could not be fetched in time (or too many fetches were in flight). Retry after the `Retry-After` delay. |
| `400 invalid_client` for a URL client id | CIMD is off, or the URL or document was refused (not https, internal host, redirect, over 5 KB, `client_id` mismatch). Auth-service logs one warning per refusal: `oauth.cimd.url_rejected` (reason, and host when the string parses as a URL; never path, query or raw input) for a URL refused before any fetch, `oauth.cimd.fetch_failed` (host, reason) after a fetch or validation failure, and `oauth.cimd.busy` (host) when the in-flight cap refuses (`cimd-client.service.ts:126-135,149-155,171-175`). Nothing is logged when the flag is off, and a repeat inside the 60 s negative cache logs nothing more. These events omit the path and query, but auth-service's general request log records the full request URL, query string included, so the refused `client_id` and the rest of the `/oauth/authorize` URL do appear there (open owner decision, `docs/06-security.md`). |

---

### Errors from `/oauth/authorize`

`GET /oauth/authorize` is a browser navigation, so only `/oauth/token` and `/oauth/clients/register` use the OAuth error filters (`oauth.controller.ts:95,109,174`). A 4xx from `/oauth/authorize` is auth-service's general error envelope, not the RFC 6749 body: `{"error":{"code":"HTTP_ERROR","message":"<the OAuth error JSON as a string>"}}` (`services/auth-service/src/common/filters/global-exception.filter.ts:59-64`; a malformed query is `VALIDATION_FAILED` in the same envelope, `:50-56`). The one exception is a temporary CIMD failure for a URL client id: 503 with `Retry-After` and a plain `{"error":"temporarily_unavailable","error_description":"..."}` body (`OAuthUnavailableFilter`, `oauth-unavailable.ts:26-46`). A host should treat any answer from `/oauth/authorize` that is not a redirect as a failure and not parse it as an RFC error.

## Planned (not in this commit)

These are tracked in the MCP platform upgrade and are **not** implemented here; nothing above depends on them.

- **A human-readable error page for `/oauth/authorize`** (today a browser shows the raw JSON envelope). Owner decision; not built.
- **A cluster egress policy for CIMD** (see above) and the decision to turn the flag on outside local.
- **Retiring the stdio package and making `aud` mandatory** on OAuth tokens at the edge (WS-N). Until then the `.mcp.json` stdio entry and `packages/ticketing-mcp-server` remain; do not use them for new work. Tokens without an `aud` claim are tolerated by the REST audience rule.

## History

The first MCP integration (April 2026) was a local stdio server that ran its own PKCE login and stored tokens on disk. Its setup notes, structure notes and status log were removed in favour of this guide. The Kong scope enforcement (`jwt-scope.lua`), dynamic client registration and consent flow it introduced are still the foundation of the current design.
