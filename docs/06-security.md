# Security

## Authentication & Authorisation

### Authentication (at the Gateway)

- Kong handles AuthN for all external requests using the **JWT** or **OAuth 2.0 / OIDC** plugin.
- Services receive a verified identity via a forwarded header (e.g. `X-User-Id`, `X-User-Roles`) injected by Kong after token validation — services must not re-validate the token.
- Internal gRPC calls propagate identity via **gRPC metadata** headers (same header names as above).
- JWTs: short-lived access tokens (15 min), long-lived refresh tokens stored server-side (Redis) and rotatable. RS256 signing — public keys distributed to Kong via JWKS endpoint.

### Consuming Service Pattern

- Downstream services **never validate JWTs themselves** — Kong is the single point of token verification.
- Services trust `X-User-Id` and `X-User-Roles` only because these headers can only arrive on traffic that has already passed the gateway; enforce this with a NetworkPolicy that rejects direct ingress bypassing Kong.
- Strip any inbound copies of these headers at the gateway so clients cannot forge identity.
- Never log raw tokens, refresh tokens, or session identifiers — redact at the logger level.

**Exception: `/mcp` (D6).** `mcp-service` is the OAuth 2.1 resource server for the `/mcp` route and verifies its own tokens; Kong runs no `jwt` plugin on `/mcp` or the protected-resource metadata route. The reason is the audience rule: an MCP token (`aud = <origin>/mcp`) would be judged and refused by the REST rules, and the resource server must answer an unauthenticated call with its own RFC 9728 challenge. What Kong still does on `/mcp`: strips `X-User-Id`, `X-User-Roles` and `X-User-Id-Sig` so a client cannot smuggle an identity downstream, and rate-limits per source IP (`RATE_LIMIT_MCP_PER_MINUTE`) (`services/kong-gateway/config/kong.base.yml`, mcp-service block). mcp-service itself calls Kong's public REST API with an exchanged, API-audience token (see [03](03-api-design.md)), so everything behind `/mcp` is authenticated and authorised by the normal gateway rules; it never forwards the host's token. No other route may skip the `jwt` plugin on this basis.

### Authorisation (in the Service)

- Authorisation is service-level responsibility — Kong does not enforce business-level permissions.
- Apply the principle of least privilege: check that the acting user owns or has permission to act on the requested resource.
- Role/permission checks must happen before any DB write or expensive computation.

### Secrets Management

- **All secrets come from environment variables injected at runtime** — never hardcoded, never in source control, never in Docker images.
- In EKS: use **AWS Secrets Manager** or **Parameter Store** with the Secrets Store CSI driver, or **External Secrets Operator** — never Kubernetes `Secret` YAML committed to Git.
- Rotate secrets without downtime by supporting dual-key validation during rotation windows.
- Never log a secret, token, password, or API key. Sanitise log output explicitly if there is any chance of exposure.

## MCP Surface Threat Model

Scope: an MCP host (an AI agent) acting for a signed-in user through `https://<origin>/mcp`. Flow and components are in [`docs/ticketing/mcp.md`](ticketing/mcp.md). Paths are relative to the repo root; "C-n" and "D-n" are the contract and decision ids in the MCP platform upgrade design. Only controls that exist in the code are listed; planned work is marked planned. Line references were re-checked against the code at the commit that merged Client ID Metadata Documents (CIMD).

### Token passthrough and confused deputy

- **Threat:** a token minted for one audience is replayed against another, or the MCP server forwards the host's token to the API, so a compromised or malicious host token reaches services that never agreed to accept it.
- **Mitigation:** the MCP access token is bound to `aud = <origin>/mcp` (RFC 8707 `resource`; an unknown resource is rejected, a token request may not change the resource, `oauth.service.ts` `assertAllowedResource`, `oauth.service.ts:144`, called at `:132`, `:214`, `:541` and `:659`). mcp-service verifies RS256, exact `iss`, exact `aud`, `exp`, `sub` and a `client_id` claim (`services/mcp-service/src/verifier.ts:59-93`). It never forwards that token: it trades it per call for a short-lived API-audience token (RFC 8693, `services/mcp-service/src/exchange.ts`, `services/auth-service/src/modules/oauth/oauth.service.ts` token-exchange grant) that keeps the original `client_id`, can only narrow scope, and expires within 5 minutes and never after the subject token (`EXCHANGED_TOKEN_MAX_SECONDS`, `oauth.service.ts:54,406`). The exchange client is authenticated with a secret compared by SHA-256 in constant time (`oauth.service.ts:513-516`); the secret is not in the OAuth client list. The reverse direction is blocked at the edge: Kong refuses an OAuth token (one with `client_id`) whose `aud` lacks `<origin>/api` with 401 `token audience not accepted` (C-10, `services/kong-gateway/plugins/jwt-scope.lua:14-18,54-75`), and `oauth-deny.lua` refuses OAuth tokens on routes that carry no OAuth scope (for example `/graphql`). Proven end to end by `services/client/tests/e2e/mcp-full-flow.spec.ts` (MCP-audience token on `/api/orders` is 401).
- **Residual:** an OAuth token with no `aud` claim is still accepted by the REST rule until `aud` is made mandatory (WS-N, planned). Auth-service issues `aud` on every OAuth token today, so this only matters for tokens minted by some other path.

### Token theft and replay

- **Threat:** an access token or authorization code is stolen (host compromise, log leak, redirect interception) and replayed.
- **Mitigation:** PKCE with S256 is mandatory and the code is single-use, consumed on read (`oauth.service.ts:193` requires S256, `:576` verifies it, `:544` consumes the code, `oauth-code-store.service.ts:67`). The redirect URI must match a registered one exactly, except that a registered `http` loopback URI may differ in port only (RFC 8252, `oauth-redirect.util.ts`). The authorization response carries `iss` (RFC 9207, `withIssuer`, `oauth.service.ts:171,301`). Access tokens are short-lived (15 minutes). Tokens are never logged and never appear in tool results: upstream errors are reduced to fixed codes and text (a non-2xx answer becomes a `ToolFailure` with a classified code, `services/mcp-service/src/upstream.ts:173-176`; unexpected failures log only the tool and error class, `tools.ts:451-462`), and the logger redacts credential fields (`services/mcp-service/src/logging.ts:19`). The token cache holds only exchanged tokens, keyed by a hash of the subject token, in process memory, bounded to 1000 entries (`exchange.ts`).
- **Residual:** bearer tokens are not sender-constrained (no DPoP or mTLS): whoever holds a valid MCP access token can call `/mcp` until it expires (up to 15 minutes). Transport confidentiality relies on TLS at the edge outside local development.

### Consent phishing and client impersonation

- **Threat:** a malicious app registers (or publishes an identity document for) a client with a trusted-looking name and tricks the user into granting scopes, or tries to make the consent screen misleading with look-alike or invisible characters.
- **Mitigation:** there are three ways to become a client: the static registry, dynamic registration (RFC 7591) and, when `OAUTH_CIMD_ENABLED` is on, a Client ID Metadata Document (below). Consent is decided in one place, `oauth.service.ts:263-265`: a client is auto-approved only if its registry entry sets `isFirstParty === true`. Dynamic clients are hard-coded `isFirstParty: false` (`dynamic-client.service.ts:72`, `oauth-clients.config.ts:77`), CIMD clients are `isFirstParty: false` (`cimd-document.ts:114`), and the only static client, `ticketing-mcp` (`oauth-clients.config.ts:28-37`), does not set the flag, so at this commit no client skips consent. The consent page shows the client name, the requested permissions with scope-registry labels, a **Sensitive** badge on scopes that act on the user's behalf, and a **Third-party app** badge (`services/client/app/oauth/consent/page.tsx`). It also shows two address lines that the client cannot choose the wording of: for a CIMD client "App identity document hosted at <host>", and "After you allow, you are sent to <host>" for the redirect destination, where a loopback destination reads "an app on this device" (`page.tsx:165-197`, built by `describeClientAddresses`, `oauth-clients.config.ts:123-148`). When the document host differs from a non-loopback redirect host, an amber **Caution** note names both (`redirectMismatch`, `page.tsx:184-197`). The client name, from DCR and from a CIMD document alike, is rejected if it holds control, format (bidirectional marks, zero-width, BOM), line or paragraph separator characters or is over 100 characters (`oauth-client-name.util.ts:7,14-23`, `oauth.dto.ts:15`), so an invisible character cannot blur two names; the Allow and Deny buttons stay disabled until the page has hydrated (`ConsentActions.tsx`). Pending consent expires after 10 minutes (`oauth-consent-store.service.ts:8,57`) and is bound to the user who started it. Authorized apps are listed and revocable in Settings -> Connected apps. Registration is public but constrained (see the redirect-URI and registration entries below).
- **Residual:** a static registry entry with `isFirstParty: true` would bypass consent entirely. That is code-reviewed configuration, not runtime input, and none exists today, but adding one is a security-relevant change. The client name is self-asserted and unverified, so a hostile app can pick any name; the client id and redirect URI are the only hard identity. For a CIMD client the document host is shown, but a document hosted on a shared host proves control of one path on that host, not of the host (see the SSRF and CIMD entry). There is no deny list of look-alike names.

### Client ID Metadata Documents and SSRF on client-metadata fetch

- **Threat:** with CIMD, an unauthenticated caller of `/oauth/authorize` or `/oauth/token` can name any HTTPS URL as `client_id`, and auth-service, which holds the token-signing key, then fetches it. An attacker points that fetch at internal addresses (cloud metadata, cluster services), uses DNS tricks (rebinding, an A record to a private address), redirects, huge or slow bodies, or many concurrent fetches.
- **What is built:** behind `OAUTH_CIMD_ENABLED` (default false: `oauth-config.ts:36`; on only in `docker-compose.yml:319` and `infra/helm/values-local.yaml:49`; staging and prod keep the default). When off, a URL `client_id` is an unknown client and nothing is fetched. When on:
  - The `client_id` must be an `https` URL of at most 512 characters, printable ASCII, with a DNS-name host (no IP literal, no single-label host, none of the internal suffixes `.internal`, `.local`, `.localhost`, `.svc`, `.cluster.local`, `.lan`, `.home.arpa`), port 443 only, a non-root path with no dot segments, and no query, fragment or userinfo (`cimd-fetcher.ts:188-234`, suffixes `:170-178`, limit `:46`). The grant `urn:...:token-exchange` refuses a URL client id before any resolve (`oauth.service.ts:492-498`), so it cannot trigger a fetch.
  - The host is resolved by the fetcher itself (c-ares, A and AAAA, 1 s per attempt, `cimd-fetcher.ts:246-299`) and every returned address is checked against a block list (loopback, private, link-local including `169.254.169.254`, CGNAT, multicast, reserved, IPv4-mapped and similar IPv6 ranges, `:97-164`). If any address is blocked the fetch is refused (`:406-410`). The TCP connection is then made to the vetted address itself, with the TLS server name and certificate bound to the original host name, so a second DNS answer cannot redirect it (`:312-356`).
  - No redirects are followed (a 3xx is a failure, `:435`), only status 200 with a JSON content type is accepted (`:438-441`), the body is capped at 5 KB (`:44,445-457`), and the whole fetch has one 3 s deadline (`:45`). At most 8 fetches run at once per auth-service process (`cimd-client.service.ts:26`); a ninth is refused as `busy`.
  - The document must repeat the `client_id` byte for byte, hold 1 to 10 redirect URIs that pass the same rule as registration, use `token_endpoint_auth_method: none` if it names one, and a valid name (`cimd-document.ts:27-118`). The resulting client is public, `isFirstParty: false`, with 900 s access and 86400 s refresh lifetimes.
  - Results are cached in Redis for the document's `Cache-Control: max-age`, clamped to 60 s minimum and 24 h maximum (`no-store` and `no-cache` get the 60 s floor, default 5 min); a verdict that the document is invalid is cached for 60 s; a `busy` result is not cached (`cimd-client.service.ts:21-26,38-46,145-181`).
  - Errors are generic to the caller and detailed only in logs, as three events (`cimd-client.service.ts`): `oauth.cimd.url_rejected` when a URL is refused before any fetch (reason code, and the host when the string parses as a URL, cut to 253 characters; never the path, query or raw input; `:126-135`), `oauth.cimd.fetch_failed` after a fetch or validation failure (host, reason; never the body or full URL; `:171-175`) and `oauth.cimd.busy` when the in-flight cap refuses (host; `:149-155`). Nothing is logged when the flag is off (`:125` returns before any log). A repeat of a failed document within the 60 s negative cache logs nothing further. A transient failure (timeout, connect failure, DNS unavailable, busy) is a 503 `temporarily_unavailable` with `Retry-After` (60 s, or 5 s for busy), so a refreshing client retries; a verdict on the document or URL is a 400 `invalid_client` (`oauth-unavailable.ts`, `oauth.service.ts:56-60,84-142`). On `GET /oauth/authorize` that 400 is auth-service's general error envelope, not the RFC body (see the guide). The E2E spec asserts that `https://169.254.169.254/x.json` and `https://foo.internal/x.json` are answered with 400 `invalid_client`, not a 5xx.
- **Residual (read these before enabling it in a cluster):**
  - Enabling CIMD in a cluster needs outbound HTTPS from auth-service, and the chart has none: `infra/helm/charts/auth-service/templates/networkpolicy.yaml` allows only DNS, PostgreSQL, Redis and Kafka egress. An egress rule (TCP 443 to the public internet excluding private ranges, plus DNS) must be written and owner-reviewed first. No such policy exists today, which is why staging and prod leave the flag off.
  - `/oauth/authorize` is unauthenticated, so any caller can cause a fetch of an attacker-chosen public URL. This is bounded by Kong's per-IP rate limit on `oauth-public` (`kong.base.yml:97-115`, fail closed), the cache (including the 60 s negative cache), the 8-per-process cap, the 5 KB and 3 s limits, and the URL rules; it is not eliminated.
  - A fetched document is trusted until its cache entry expires, up to 24 hours, and there is no purge: a document that changes its redirect URIs, or is taken down, keeps its previous effect for that long.
  - A document on a shared host (a user-content or paste site) proves control of a path, not of the host. The controls are the consent screen's document host, the redirect destination and the mismatch caution; there is no deny list of shared hosts.
  - The block list, DNS pinning and size and time limits are covered by unit tests, but no fetch of a real public document has been verified on a running stack: the E2E spec deliberately contacts no external host.
  - **Open owner decision: the request log records the full query string.** The three `oauth.cimd.*` events carry reason and host only, but auth-service's general request log (pino-http, `app.module.ts:47-70`) logs `req.url` for every route (the `req` serializer, `:65-69`, keeps only method and url), so the complete `/oauth/authorize` URL is in the access log: `client_id` (the full document URL for a CIMD client, path and query included), `redirect_uri`, `scope`, `state`, `code_challenge` and `resource`. A refused URL client id therefore appears in full in the "request completed" line even though the `url_rejected` event omits it (seen on a running stack). The `redact` list (`:60-64`) covers only `req.headers.authorization`, `req.headers.cookie` and `req.headers["x-user-id-sig"]`; no query parameter and no URL path is redacted. Checked at this commit: on the OAuth routes no token or client secret is in a query string (`/oauth/token`, `/oauth/revoke` and `/oauth/clients/register` take POST bodies; `/oauth/authorize` and `DELETE /oauth/clients` take `client_id`, `redirect_uri`, `scope`, `state`, PKCE challenge and `resource`, `oauth.controller.ts:81-91,134-136`), though the consent request id travels in the path of `/oauth/consent/:requestId` (`:183,201`) and is logged. Decision needed: strip or redact the query string in the auth-service request log. Not changed in this wave.
  - Dynamic registration is unchanged in behaviour and is deprecated in code (`oauth.service.ts:913`); both paths stay live.

### Tool-call replay and duplicate side effects

- **Threat:** an agent (or a retrying transport) repeats a mutating call and buys twice.
- **Mitigation:** `create_order` and the seated variant send an `Idempotency-Key` derived from `sha256(sub, tool, canonical arguments)`, truncated to 43 base64url characters; an explicit `idempotencyKey` overrides it (`services/mcp-service/src/idempotency.ts`). order-service answers a repeat with the original order and `Idempotent-Replayed: true`; the tool surfaces `replayed`. Asserted by the E2E spec (second identical call returns the same order id and `replayed: true`).
- **Residual:** the key is deterministic, so two deliberate identical purchases by the same user collapse into one unless the caller passes a distinct `idempotencyKey`. Payment tools carry no derived key (`tools.ts`, `pay_for_order*`); a repeated payment call relies on payment-service's own duplicate handling, not verified for this model.

### Scope escalation and step-up

- **Threat:** a token granted read access is used for writes, or a call quietly widens its own authority.
- **Mitigation:** every tool declares the scopes it needs (`services/mcp-service/src/scopes.ts`, `tools.ts`). A missing scope gives 403 `insufficient_scope` with the held plus required scopes, so the host asks the user for the difference rather than for everything again (`scopes.ts:48-55`). The first 401 challenge asks for read scopes only. The exchanged token can only narrow the subject token's scopes (`oauth.service.ts:412-420`), and Kong checks the scope against the route again at the REST edge (`jwt-scope.lua`). Asserted by the E2E spec (token without `orders:create` gets a step-up 403 on `create_order`).
- **Residual:** scopes are coarse (any amount, any order the user owns). The consent screen is the only gate before the user's `orders:create` and `payments:create` grants are usable.

### Revocation window

- **Threat:** the user revokes a connected app, but an already-issued token keeps working.
- **Mitigation:** the user revokes in Settings -> Connected apps (`services/client/app/settings/connected-apps.ts:64-71`). The browser action calls `DELETE /oauth/clients?client_id=<id>` (the query form, because a URL client id contains `:` and `/`; `oauth.controller.ts:130-148`), and the older `DELETE /oauth/clients/:clientId` form is kept for opaque ids (`:150`); both carry the gateway-signed user id. `revokeClient` (`oauth.service.ts:808-825`) lists the user's refresh sessions and, for each whose session-scope marker names that client, deletes the refresh session and the marker. After that no refresh can succeed and no new access token can be obtained for that client. It does not delete the client registration (a DCR client key keeps its one-year TTL, a CIMD client stays cached) and does not revoke already-issued access tokens. The consent store holds only pending consents for 10 minutes (`oauth-consent-store.service.ts:8`), so there is no consent history to delete. Exchanged API tokens live at most 5 minutes.
- **Residual (accepted):** an MCP access token issued before revocation stays valid, and exchangeable, until it expires, up to 15 minutes (documented at `oauth.service.ts:348-352`). Only the token-id blacklist and deleting the user block exchange earlier.

### Bearer token theft and replay from the host

- **Threat:** the MCP host (or its machine) leaks an access or refresh token, and an attacker replays it.
- **Mitigation:** bounds, not prevention. The access token is audience-bound to `<origin>/mcp`, so it is useless against the REST API (`jwt-scope.lua:54-75`), and lives 15 minutes (`oauth-clients.config.ts:35` static client, `dynamic-client.service.ts:70`, `cimd-document.ts:112`; all 900 s). The refresh token is stored as a hash, compared on use (`refresh-token.service.ts:203`) and rotated on every refresh, replacing the stored hash (`refresh-token.service.ts:277-309`).
- **Refresh lifetime is sliding, with two clocks.** Each successful refresh re-stores the session record with `REFRESH_TOKEN_TTL_SECONDS` (`refresh-token.service.ts:181-187`; compose default 604800 s, 7 days) and re-stores the OAuth session-scope marker with the client's refresh lifetime, 86400 s (24 h) for the static, dynamic and CIMD clients (`oauth.service.ts:732-739`, `oauth-code-store.service.ts:103-115`). A refresh token unused for 24 h fails, because the marker has lapsed (`oauth.service.ts:711-719`; the rotation has already happened by then). A refresh token used at least once every 24 h does not expire: a stolen refresh token stays usable indefinitely until the user revokes the app or the user is deleted.
- **Residual:** there is no sender-constraining (no DPoP, no mTLS). There is no refresh-token reuse detection: rotation replaces the stored hash but a replay of an old token is not treated as a theft signal and does not revoke the session family. Rotation is not atomic: `rotate` reads the record and then writes the successor (`refresh-token.service.ts:282-303`), so two concurrent requests presenting the same token can each obtain a valid successor. A stolen access token works for up to 15 minutes. Whichever party refreshes first invalidates the other's copy in the sequential case, but nothing flags it.

### Redirect-URI abuse through dynamic registration

- **Threat:** an attacker registers a client whose redirect URI points at a host they control, then lures a user through consent so the authorization code lands with the attacker (code interception / open redirect). This is not SSRF: the server never fetches a redirect URI.
- **Mitigation:** registration (DCR and CIMD share one rule, `oauth-redirect.util.ts:48-82`) accepts only `https` URIs, or `http` on `localhost` / `127.0.0.1`, with no fragment (even an empty `#`) and no userinfo; a URI that fails the DTO's URL check (for example `https://:@a.example/cb`) is `invalid_client_metadata`, and one that fails the fragment, userinfo or scheme rule is `invalid_redirect_uri`; both are 400 (`oauth.dto.ts:176`, `oauth-exception.filter.ts:88-93`). At authorize time the requested URI must match a registered one exactly (`oauth-redirect.util.ts:20-40`), except that an `http` loopback URI may differ in port only (a loopback request carrying credentials or a fragment is refused). The token request must repeat the same `redirect_uri` (`oauth.service.ts:558`), the code is single-use and PKCE S256 is mandatory, so an intercepted code is useless without the verifier. The consent screen shows the redirect destination in words the client does not control.
- **Residual:** any attacker-owned `https` host is a valid registration, and the user is asked to judge it on the consent screen from a self-asserted client name (see consent phishing above). PKCE protects the code, not the user's decision.

### Unbounded dynamic registration

- **Threat:** an attacker registers clients in a loop to exhaust storage or to pollute the consent screen.
- **Mitigation:** `POST /oauth/clients/register` is rate-limited per source IP by Kong's `oauth-public` route (`RATE_LIMIT_AUTH_ENDPOINTS_PER_MINUTE`, fail-closed, `kong.base.yml:97-115`). Each registered client is a Redis key with a one-year TTL (`dynamic-client.service.ts:10,77-81`), so abandoned clients expire. What an integrator sees at registration: redirect URIs must be `https`, or `http` only on `localhost` / `127.0.0.1`, with no fragment and no userinfo (`invalid_redirect_uri`, or `invalid_client_metadata` when the DTO's URL check rejects the value first, for example `https://:@a.example/cb`; both 400); `client_name` must be at most 100 characters with no control or formatting characters (`invalid_client_metadata`); `application_type` is `native` or `web` (default `web`, `oauth.dto.ts:188-191`); unknown scopes are dropped.
- **Residual:** there is no cap on the number of dynamic clients, no per-account or global quota, and no authentication on registration. An attacker with many source IPs is limited only by the one-year expiry. The legacy static `ticketing-mcp` client (a loopback redirect for the stdio package) stays registered until the stdio package is retired (WS-N, planned).

### Token-exchange credential

- **Threat:** mcp-service's client secret leaks, letting an attacker call the RFC 8693 exchange.
- **Mitigation:** auth-service stores only the SHA-256 of the secret and compares it in constant time (`oauth.service.ts:513-516`); the secret lives in the git-ignored `.env` and is validated at startup (mcp-service refuses to boot without it, auth-service refuses a malformed hash). Only the client id `mcp-service` may use the grant; any other client gets `unauthorized_client` (`oauth.service.ts:492-507`). The exchange accepts only a subject token whose single audience is the MCP resource (`oauth.service.ts:400`), can only narrow scope (`oauth.service.ts:418`), and yields a token of at most 5 minutes that never outlives the subject (`oauth.service.ts:406`).
- **Residual:** an attacker with the secret still needs a valid, unexpired MCP-audience user token to exchange, so a leak alone grants no user access; it does let that attacker convert any MCP token they hold into an API token for its remaining life. There is no rotation mechanism beyond redeploying with a new secret and hash.

### Tool output reaching the model

- **Threat:** text returned by tools (event titles, descriptions) is organiser-controlled and is read by the model, which is the prompt-injection channel covered below.
- **Mitigation:** upstream bodies are validated against a per-tool output schema before they are returned (`tools.ts:436-445`), so responses that do not match the expected shape are rejected, and errors, tokens and headers are never put in a result (see above).
- **Residual:** content is not filtered. The schemas check shape, not content, and several are `z.looseObject` (`tools.ts:87`), so event names and descriptions pass through verbatim, with no sanitising, labelling or length cap beyond the upstream's own limits.

### Rate limiting and shared IPs

- **Threat:** abuse or a runaway agent loop floods `/mcp`; conversely, one noisy client exhausts a shared limit.
- **Mitigation:** `/mcp` is limited per source IP by Kong (`RATE_LIMIT_MCP_PER_MINUTE`, 600 by default, higher locally), because the caller is unauthenticated at the edge. The exchanged calls then pass the REST routes and their own limits and the waiting room, like any client. Upstream calls time out after 10 s and exchange after 5 s.
- **Residual:** limiting by IP means users behind one NAT or proxy share a budget, and an attacker with many IPs is not limited by this control. There is no per-user or per-client limit on `/mcp` itself.

### Prompt-injection-driven tool misuse

- **Threat:** text the agent reads (an event title, a description, an order note) carries instructions that make it call tools the user did not intend, for example buying or paying.
- **What the server does:** it limits blast radius rather than detecting injection. The user approved a fixed scope set on a consent screen that flags the sensitive ones; actions run as that user, so downstream ownership checks apply; mutating calls are idempotent; the waiting room and rate limits cannot be bypassed; and the user can revoke the app. Attribution to the agent is narrower than it may sound: auth-service logs an `oauth.token.exchanged` audit event with `userId`, `originalClientId` and the granted scope on every exchange (`oauth.service.ts:444`), and that is the only place the client id is logged. mcp-service logs the tool name and status or OAuth error code, not the client id or user (`upstream.ts:140-176`). The exchanged token does carry `client_id` and `act: {sub: "mcp-service"}` (`oauth.service.ts:433-435`), but no upstream service uses them: Kong reads `client_id` only to apply the scope and audience rules (`jwt-scope.lua:56`), and order-service, payment-service and ticket-service sources do not reference `client_id` at all (grep). Upstream services therefore cannot tell an agent call from a browser call except by those token claims. Beyond the audit event, the agent-specific trail is the derived `Idempotency-Key` on `create_order`.
- **What it does not do:** it marks cancel and pay tools with the MCP `destructiveHint` (`tools.ts`) but does not enforce it, does not sanitise or label tool output before the model sees it, does not require a per-call human confirmation, and has no per-token spend or order-count cap. Whether a purchase needs the user's approval is the host's decision. Users who do not want an agent to pay should not grant `payments:create`.
- **Residual:** within granted scopes, an injected instruction can place orders or pay for them as the user. This is inherent to delegating write access to an agent and is only reduced by narrow scopes and host-side confirmation.

## Input Validation

- Validate every field of every external request at the service boundary — type, format, length, range, allowed values.
- Use a schema-based validation library (Zod, Joi, Pydantic, Jakarta Bean Validation, go-playground/validator) — not manual `if` chains.
- Reject unknown fields — do not pass them through or store them.
- Sanitise user-supplied strings before using them in DB queries, log lines, or templated responses.

## Injection Prevention

- **SQL**: use parameterised queries / prepared statements exclusively. ORM query builders are acceptable but must never concatenate raw user input.
- **NoSQL**: use the ORM/driver query builder API. Never construct a query object from raw user input.
- **Command injection**: never pass user input to `exec`, `spawn`, or shell commands.
- **SSRF**: validate and whitelist URLs before making outbound HTTP requests. Never allow user-supplied URLs to internal network ranges.
- **Log injection**: sanitise user input before including in log messages (strip newlines at minimum).

## Transport Security

- All traffic between Kong and external clients: TLS 1.2+ (enforce TLS 1.3 where possible).
- All traffic inside the cluster: mTLS via a service mesh (Istio or Linkerd) — services do not implement mTLS themselves.
- Local Kubernetes should mirror this rule: install Linkerd during bootstrap, inject only the workloads that participate in internal gRPC, and apply Linkerd policy on the gRPC port rather than whole-pod deny rules so HTTP traffic from Kong is unaffected.
- For Kafka with Linkerd, explicitly skip the raw broker ports used by the binary protocol; do not rely on the proxy to interpret Kafka traffic.
- Never disable certificate verification (`InsecureSkipVerify`, `rejectUnauthorized: false`) except in local dev, and even then prefer self-signed certs over disabling verification.

## Supply Chain

- Pin all base Docker images to a specific digest (not just a tag).
- Run `npm audit` / `go vuln` / `pip-audit` / `trivy` in CI — fail the build on high/critical CVEs.
- Use a private container registry — never pull untrusted images in production.
- Keep dependencies up to date with automated PRs (Dependabot or Renovate).
