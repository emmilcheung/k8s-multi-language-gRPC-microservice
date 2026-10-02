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

Scope: an MCP host (an AI agent) acting for a signed-in user through `https://<origin>/mcp`. Flow and components are in [`docs/ticketing/mcp.md`](ticketing/mcp.md). Paths are relative to the repo root; "C-n" and "D-n" are the contract and decision ids in the MCP platform upgrade design. Only controls that exist in the code are listed; planned work is marked planned.

### Token passthrough and confused deputy

- **Threat:** a token minted for one audience is replayed against another, or the MCP server forwards the host's token to the API, so a compromised or malicious host token reaches services that never agreed to accept it.
- **Mitigation:** the MCP access token is bound to `aud = <origin>/mcp` (RFC 8707 `resource`; an unknown resource is rejected, a token request may not change the resource, `oauth.service.ts` `assertAllowedResource` and the code exchange). mcp-service verifies RS256, exact `iss`, exact `aud`, `exp`, `sub` and a `client_id` claim (`services/mcp-service/src/verifier.ts:59-93`). It never forwards that token: it trades it per call for a short-lived API-audience token (RFC 8693, `services/mcp-service/src/exchange.ts`, `services/auth-service/src/modules/oauth/oauth.service.ts` token-exchange grant) that keeps the original `client_id`, can only narrow scope, and expires within 5 minutes and never after the subject token (`EXCHANGED_TOKEN_MAX_SECONDS`, `oauth.service.ts:50,338`). The exchange client is authenticated with a secret compared by SHA-256 in constant time (`oauth.service.ts:440-447`); the secret is not in the OAuth client list. The reverse direction is blocked at the edge: Kong refuses an OAuth token (one with `client_id`) whose `aud` lacks `<origin>/api` with 401 `token audience not accepted` (C-10, `services/kong-gateway/plugins/jwt-scope.lua:14-18,54-75`), and `oauth-deny.lua` refuses OAuth tokens on routes that carry no OAuth scope (for example `/graphql`). Proven end to end by `services/client/tests/e2e/mcp-full-flow.spec.ts` (MCP-audience token on `/api/orders` is 401).
- **Residual:** an OAuth token with no `aud` claim is still accepted by the REST rule until `aud` is made mandatory (WS-N, planned). Auth-service issues `aud` on every OAuth token today, so this only matters for tokens minted by some other path.

### Token theft and replay

- **Threat:** an access token or authorization code is stolen (host compromise, log leak, redirect interception) and replayed.
- **Mitigation:** PKCE with S256 is mandatory and the code is single-use, consumed on read (`oauth.service.ts:131-137,473`). The redirect URI must match a registered one exactly, except that a registered `http` loopback URI may differ in port only (RFC 8252, `oauth-redirect.util.ts`). The authorization response carries `iss` (RFC 9207, `oauth.service.ts:233`). Access tokens are short-lived (15 minutes). Tokens are never logged and never appear in tool results: upstream errors are reduced to fixed codes and text (a non-2xx answer becomes a `ToolFailure` with a classified code, `services/mcp-service/src/upstream.ts:173-176`; unexpected failures log only the tool and error class, `tools.ts:451-462`), and the logger redacts credential fields (`services/mcp-service/src/logging.ts:19`). The token cache holds only exchanged tokens, keyed by a hash of the subject token, in process memory, bounded to 1000 entries (`exchange.ts`).
- **Residual:** bearer tokens are not sender-constrained (no DPoP or mTLS): whoever holds a valid MCP access token can call `/mcp` until it expires (up to 15 minutes). Transport confidentiality relies on TLS at the edge outside local development.

### Consent phishing and dynamic-client impersonation

- **Threat:** a malicious app registers a client with a trusted-looking name and tricks the user into granting scopes.
- **Mitigation:** registration (RFC 7591) is public but constrained: redirect URIs must be HTTPS or localhost, unknown scopes are dropped, and the route is rate-limited per IP like the other auth endpoints, failing closed if the limiter backend is down (`oauth.service.ts:830-862`, `kong.base.yml` `oauth-public`). Consent is decided in one place, `oauth.service.ts:201-203`: a client is auto-approved only if its registry entry sets `isFirstParty === true`. Every dynamically registered client is hard-coded `isFirstParty: false` (`dynamic-client.service.ts:92`, `oauth-clients.config.ts:68`), so a client that registers itself always sees the consent screen. At this commit no client skips consent: the only static client, `ticketing-mcp` (`oauth-clients.config.ts:19-28`), does not set the flag. The consent page shows the client name and client id, the requested permissions with scope-registry labels, and a **Sensitive** badge on scopes that act on the user's behalf (`services/auth-service/src/modules/oauth/oauth-scopes.ts`, `services/client/app/oauth/consent/`). Pending consent expires after 10 minutes and is bound to the user who started it. Grants are listed and revocable in Settings -> Connected apps.
- **Residual:** a static registry entry with `isFirstParty: true` would bypass consent entirely. That is code-reviewed configuration, not runtime input, and none exists today, but adding one is a security-relevant change. The client name is self-asserted and unverified, so a hostile app can pick any name; the client id and redirect URI are the only hard identity. Client ID Metadata Documents (WS-I, behind `OAUTH_CIMD_ENABLED`) are planned and would let a client prove a domain; they are not implemented at this commit.

### SSRF on client-metadata fetch

- **Threat:** if the authorization server fetches a client's metadata document by URL (CIMD), an attacker points it at internal addresses.
- **Mitigation:** none needed today, because no such fetch exists: the authorization server does not dereference any client-supplied URL, so this surface is absent in this commit. The generic SSRF rule in this document applies when WS-I lands: allow-list or block internal ranges, cap size and time, no redirects, and keep it behind `OAUTH_CIMD_ENABLED`.
- **Residual:** planned work, not yet reviewable.

### Tool-call replay and duplicate side effects

- **Threat:** an agent (or a retrying transport) repeats a mutating call and buys twice.
- **Mitigation:** `create_order` and the seated variant send an `Idempotency-Key` derived from `sha256(sub, tool, canonical arguments)`, truncated to 43 base64url characters; an explicit `idempotencyKey` overrides it (`services/mcp-service/src/idempotency.ts`). order-service answers a repeat with the original order and `Idempotent-Replayed: true`; the tool surfaces `replayed`. Asserted by the E2E spec (second identical call returns the same order id and `replayed: true`).
- **Residual:** the key is deterministic, so two deliberate identical purchases by the same user collapse into one unless the caller passes a distinct `idempotencyKey`. Payment tools carry no derived key (`tools.ts`, `pay_for_order*`); a repeated payment call relies on payment-service's own duplicate handling, not verified for this model.

### Scope escalation and step-up

- **Threat:** a token granted read access is used for writes, or a call quietly widens its own authority.
- **Mitigation:** every tool declares the scopes it needs (`services/mcp-service/src/scopes.ts`, `tools.ts`). A missing scope gives 403 `insufficient_scope` with the held plus required scopes, so the host asks the user for the difference rather than for everything again (`scopes.ts:48-55`). The first 401 challenge asks for read scopes only. The exchanged token can only narrow the subject token's scopes (`oauth.service.ts:344-347`), and Kong checks the scope against the route again at the REST edge (`jwt-scope.lua`). Asserted by the E2E spec (token without `orders:create` gets a step-up 403 on `create_order`).
- **Residual:** scopes are coarse (any amount, any order the user owns). The consent screen is the only gate before the user's `orders:create` and `payments:create` grants are usable.

### Revocation window

- **Threat:** the user revokes a connected app, but an already-issued token keeps working.
- **Mitigation:** the user revokes in Settings -> Connected apps, which calls `DELETE /oauth/clients/:clientId` (`services/client/app/settings/connected-apps.ts:59`, `oauth.controller.ts:127-143`; the call carries the gateway-signed user id). That deletes the user's refresh sessions and stored grants for the client at once (`oauth.service.ts:728-745`), so no new access token can be obtained. It does not delete the client registration and does not revoke already-issued access tokens. Exchanged API tokens live at most 5 minutes.
- **Residual (accepted):** an MCP access token issued before revocation stays valid, and exchangeable, until it expires, up to 15 minutes (documented at `oauth.service.ts:280-289`). Only the token-id blacklist and deleting the user block exchange earlier.

### Bearer token theft and replay from the host

- **Threat:** the MCP host (or its machine) leaks an access or refresh token, and an attacker replays it.
- **Mitigation:** bounds, not prevention. The access token is audience-bound to `<origin>/mcp`, so it is useless against the REST API (`jwt-scope.lua:54-75`), and lives 15 minutes (`oauth-clients.config.ts` static client 900 s; dynamic clients 900 s, `dynamic-client.service.ts`). The refresh token is stored as a hash, compared on use (`refresh-token.service.ts:203`) and rotated on every refresh, replacing the stored hash (`refresh-token.service.ts:277-300`). Refresh lifetime is 86400 s (24 h) for both static and dynamic clients.
- **Residual:** there is no sender-constraining (no DPoP, no mTLS), and no refresh-token reuse detection: the code replaces the stored hash on rotation but does not treat a replay of an old refresh token as a theft signal or revoke the session family. A stolen access token works for up to 15 minutes. A stolen refresh token works until the session expires or the user revokes the app; whichever party refreshes first invalidates the other's copy, but nothing flags it or revokes the session.

### Redirect-URI abuse through dynamic registration

- **Threat:** an attacker registers a client whose redirect URI points at a host they control, then lures a user through consent so the authorization code lands with the attacker (code interception / open redirect). This is not SSRF: the server never fetches a redirect URI.
- **Mitigation:** registration accepts only `https` URIs or `localhost` / `127.0.0.1` (`dynamic-client.service.ts:49-68`). At authorize time the requested URI must match a registered one exactly (`oauth-redirect.util.ts:22`), except that an `http` loopback URI may differ in port only (a loopback request carrying credentials or a fragment is refused, `oauth-redirect.util.ts:23-37`). The token request must repeat the same `redirect_uri` (`oauth.service.ts:487`), the code is single-use and PKCE S256 is mandatory, so an intercepted code is useless without the verifier.
- **Residual:** any attacker-owned `https` host is a valid registration, and the user is asked to judge it on the consent screen from a self-asserted client name (see consent phishing above). PKCE protects the code, not the user's decision.

### Unbounded dynamic registration

- **Threat:** an attacker registers clients in a loop to exhaust storage or to pollute the consent screen.
- **Mitigation:** `POST /oauth/clients/register` is rate-limited per source IP by Kong's `oauth-public` route (`RATE_LIMIT_AUTH_ENDPOINTS_PER_MINUTE`, fail-closed, `kong.base.yml:98-115`). Each registered client is a Redis key with a one-year TTL (`dynamic-client.service.ts:6,96-99`), so abandoned clients expire.
- **Residual:** there is no cap on the number of dynamic clients, no per-account or global quota, and no authentication on registration. An attacker with many source IPs is limited only by the one-year expiry.

### Token-exchange credential

- **Threat:** mcp-service's client secret leaks, letting an attacker call the RFC 8693 exchange.
- **Mitigation:** auth-service stores only the SHA-256 of the secret and compares it in constant time (`oauth.service.ts:440-447`); the secret lives in the git-ignored `.env` and is validated at startup (mcp-service refuses to boot without it, auth-service refuses a malformed hash). Only the client id `mcp-service` may use the grant; any other client gets `unauthorized_client` (`oauth.service.ts:424-436`). The exchange accepts only a subject token whose single audience is the MCP resource (`oauth.service.ts:331-334`), can only narrow scope (`oauth.service.ts:344-347`), and yields a token of at most 5 minutes that never outlives the subject (`oauth.service.ts:338`).
- **Residual:** an attacker with the secret still needs a valid, unexpired MCP-audience user token to exchange, so a leak alone grants no user access; it does let that attacker convert any MCP token they hold into an API token for its remaining life. There is no rotation mechanism beyond redeploying with a new secret and hash.

### Tool output reaching the model

- **Threat:** text returned by tools (event titles, descriptions) is organiser-controlled and is read by the model, which is the prompt-injection channel covered below.
- **Mitigation:** upstream bodies are validated against a per-tool output schema before they are returned (`tools.ts:436-445`), so malformed or oversized-shape responses are rejected, and errors, tokens and headers are never put in a result (see above).
- **Residual:** content is not filtered. The schemas check shape, not content, and several are `z.looseObject` (`tools.ts:87`), so event names and descriptions pass through verbatim, with no sanitising, labelling or length cap beyond the upstream's own limits.

### Rate limiting and shared IPs

- **Threat:** abuse or a runaway agent loop floods `/mcp`; conversely, one noisy client exhausts a shared limit.
- **Mitigation:** `/mcp` is limited per source IP by Kong (`RATE_LIMIT_MCP_PER_MINUTE`, 600 by default, higher locally), because the caller is unauthenticated at the edge. The exchanged calls then pass the REST routes and their own limits and the waiting room, like any client. Upstream calls time out after 10 s and exchange after 5 s.
- **Residual:** limiting by IP means users behind one NAT or proxy share a budget, and an attacker with many IPs is not limited by this control. There is no per-user or per-client limit on `/mcp` itself.

### Prompt-injection-driven tool misuse

- **Threat:** text the agent reads (an event title, a description, an order note) carries instructions that make it call tools the user did not intend, for example buying or paying.
- **What the server does:** it limits blast radius rather than detecting injection. The user approved a fixed scope set on a consent screen that flags the sensitive ones; actions run as that user, so downstream ownership checks apply; mutating calls are idempotent; the waiting room and rate limits cannot be bypassed; and the user can revoke the app. Attribution to the agent is narrower than it may sound: auth-service logs an `oauth.token.exchanged` audit event with `userId`, `originalClientId` and the granted scope on every exchange (`oauth.service.ts:374-382`), and that is the only place the client id is logged. mcp-service logs the tool name and status or OAuth error code, not the client id or user (`upstream.ts:140-176`). The exchanged token does carry `client_id` and `act: {sub: "mcp-service"}` (`oauth.service.ts:362-368`), but no upstream service uses them: Kong reads `client_id` only to apply the scope and audience rules (`jwt-scope.lua:56`), and order-service, payment-service and ticket-service sources do not reference `client_id` at all (grep). Upstream services therefore cannot tell an agent call from a browser call except by those token claims. Beyond the audit event, the agent-specific trail is the derived `Idempotency-Key` on `create_order`.
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
