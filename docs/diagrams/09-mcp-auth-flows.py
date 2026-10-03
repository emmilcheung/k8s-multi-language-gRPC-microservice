"""MCP agent authentication in AWS style (five flows, A to E): OAuth 2.1 + PKCE, client identity by
Client ID Metadata Document (CIMD) or dynamic registration, audience-bound tokens and RFC 8693 token exchange.
Source of truth: services/mcp-service, services/auth-service/src/modules/oauth, services/kong-gateway (kong.base.yml, jwt-scope.lua),
docs/ticketing/mcp.md.
Run: python3 09-mcp-auth-flows.py"""
from awsdiagram import Sequence
from diagrams.aws.compute import Fargate
from diagrams.aws.database import ElasticacheForRedis
from diagrams.aws.general import Client, InternetAlt1, Users

P = [
    dict(id="U", icon=Users, label="User\nbrowser"),
    dict(id="H", icon=Client, label="MCP host\nClaude Code"),
    dict(id="FE", icon=Fargate, label="client\nNext.js (sign-in, consent)"),
    dict(id="K", icon=Fargate, label="kong-gateway"),
    dict(id="M", icon=Fargate, label="mcp-service\nresource server"),
    dict(id="A", icon=Fargate, label="auth-service\nauthorization server"),
    dict(id="RD", icon=ElasticacheForRedis, label="ElastiCache Redis\nauth-service"),
    dict(id="CD", icon=InternetAlt1, label="Host-served\nclient metadata URL"),
    dict(id="DS", icon=Fargate, label="downstream services\norder / ticket / venue / payment"),
]
s = Sequence(
    "MCP agent authentication on AWS",
    "OAuth 2.1 + PKCE with an audience-bound token for /mcp, exchanged per call for a one-scope API token (RFC 8693)",
    P,
    zones=[("Client side", 0, 2, "amber"), ("Edge + EKS", 3, 5, "blue"), ("Data", 6, 6, "purple"),
           ("External", 7, 7, "green"), ("Services", 8, 8, "blue")],
    spacing=215, margin=150)

# ---------------- Flow A
s.phase("Flow A  -  Discovery: the host starts with only the MCP URL", "amber")
s.m("H", "K", "POST /mcp (no token)")
s.m("K", "M", "forward (no jwt plugin on /mcp; X-User-* headers stripped; rate limited per IP)")
s.m("M", "H", "401  WWW-Authenticate: Bearer resource_metadata=.../oauth-protected-resource/mcp, scope=read scopes", ret=True)
s.m("H", "M", "GET /.well-known/oauth-protected-resource/mcp (RFC 9728, public)")
s.m("M", "H", "{ resource: <origin>/mcp, authorization_servers, scopes_supported, bearer_methods_supported: header }", ret=True)
s.m("H", "A", "GET /.well-known/oauth-authorization-server (RFC 8414)")
s.m("A", "H", "{ authorize / token / registration endpoints, S256 only, client_id_metadata_document_supported }", ret=True)

# ---------------- Flow B
s.phase("Flow B  -  Client identity: metadata document (CIMD) or dynamic registration", "purple")
s.branch("alt", "host supports CIMD and OAUTH_CIMD_ENABLED (local only): client_id is an https URL the host serves")
s.m("H", "A", "GET /oauth/authorize?client_id=https://host.example/client.json ...")
s.self_("A", "validate the URL: https, DNS name, port 443, no query / fragment / userinfo, no IP literal or internal suffix (.local, .internal, .svc)", "data")
s.m("A", "RD", "cached document or cached failure for this URL?", "data")
s.m("A", "CD", "GET client.json (no redirects, 3 s timeout, 5 KB cap, JSON only; private addresses refused)", "ext")
s.m("CD", "A", "200 { client_id == URL, client_name, redirect_uris (1..10), token_endpoint_auth_method none }", "ext", ret=True)
s.m("A", "RD", "cache for Cache-Control max-age (60 s to 24 h); failures cached 60 s", "data")
s.note("A", "Refused document: 400 invalid_client. Timeout / DNS failure / busy: 503 + Retry-After. The client is public and never first-party, so consent is always shown.", "right")
s.branch("else", "other hosts (Claude Code today): dynamic client registration")
s.m("H", "A", "POST /oauth/clients/register (RFC 7591; https or loopback redirect URIs, client_name, native | web)")
s.m("A", "H", "{ client_id }  (public client, never first-party)", ret=True)

# ---------------- Flow C
s.phase("Flow C  -  Authorization code + PKCE S256, consent, token for the MCP audience", "blue")
s.self_("H", "code_verifier, code_challenge = S256(verifier); start loopback listener for the redirect", "data")
s.m("H", "U", "open browser", ret=True)
s.m("U", "A", "GET /oauth/authorize?client_id&redirect_uri&code_challenge&resource=<origin>/mcp&scope")
s.branch("alt", "no signed-in session")
s.m("A", "U", "302 client /auth/signin?next=... (web login, see the auth flows diagram)", ret=True)
s.branch("then", "signed in: pending consent for this client + scopes")
s.m("A", "RD", "store PendingConsent { client, user, scopes, redirect_uri, challenge } TTL 10 min as request_id", "data")
s.m("A", "U", "302 client /oauth/consent?request_id=...", ret=True)
s.m("U", "FE", "consent card: app identity (host of the metadata URL), redirect target, scopes; sensitive scopes marked")
s.m("FE", "K", "POST /oauth/consent/<id>  Allow (JWT cookie, user must own the request)")
s.m("K", "A", "forward, consume the pending consent once")
s.m("A", "RD", "SET oauth:code:<code> { client, user, scope, resource, challenge } TTL 600 s", "data")
s.m("A", "U", "302 redirect_uri?code=<code>&iss=...", ret=True)
s.m("U", "H", "browser hits the host's loopback callback", ret=True)
s.m("H", "A", "POST /oauth/token (code, code_verifier, redirect_uri, resource=<origin>/mcp)")
s.m("A", "RD", "GET + DEL code; verify S256(verifier) equals stored challenge; SET refresh session + session-scope marker", "data")
s.m("A", "H", "{ access_token aud=<origin>/mcp (RS256, 15 min), refresh_token (sliding, 24 h idle), scope }", ret=True)
s.note("A", "A token without a resource is minted for /mcp only. Dynamic and CIMD clients cannot obtain an /api token directly.", "right")

# ---------------- Flow D
s.phase("Flow D  -  Tool call: verify, step-up if needed, exchange, then the normal API path", "green")
s.m("H", "K", "POST /mcp  tools/call create_order  Authorization: Bearer <aud=/mcp>")
s.m("K", "M", "forward (Kong does not run the jwt plugin here: mcp-service verifies its own audience)")
s.self_("M", "verify RS256 via auth-service JWKS: signature, iss, aud == <origin>/mcp, exp, client_id", "data")
s.branch("alt", "token lacks the tool's scope (orders:create)")
s.m("M", "H", "403  WWW-Authenticate: Bearer error=insufficient_scope, scope=<held + required>", ret=True)
s.note("H", "Step-up: the host reruns Flow C with the union of scopes, so the user is only asked for the new one.", "right")
s.branch("else", "scope present")
s.m("M", "A", "POST /oauth/token grant_type=token-exchange (RFC 8693), client-authenticated, scope narrowed to orders:create")
s.m("A", "RD", "re-check the subject token, session and not-before time for this user + client", "data")
s.m("A", "M", "API token aud=<origin>/api, same client_id, 5 min life (cached by mcp-service for at most 60 s)", ret=True)
s.m("M", "K", "POST /api/orders  Bearer <aud=/api>  Idempotency-Key = sha256(sub, tool, args, 15 min window)")
s.self_("K", "jwt plugin + jwt-scope.lua: verify RS256, require aud == <origin>/api and the scope; inject X-User-Id", "data")
s.note("K", "An /mcp-audience token is refused here with 401 'token audience not accepted'. Waiting-room and rate-limit rules apply as for any client.", "right")
s.m("K", "DS", "forward (mesh-internal)")
s.m("DS", "K", "201 order (or 409 / 403 / waiting room)", ret=True)
s.m("K", "M", "response passed through", ret=True)
s.m("M", "H", "tool result, or a fixed error code such as WAITING_ROOM_ACTIVE", ret=True)

# ---------------- Flow E
s.phase("Flow E  -  Revocation: Settings, Connected apps, Disconnect", "red")
s.m("U", "FE", "Disconnect the app")
s.m("FE", "K", "DELETE /oauth/clients?client_id=<id> (signed-in user)")
s.m("K", "A", "forward")
s.m("A", "RD", "delete session-scope marker + refresh sessions for this user + client; record a not-before time", "data")
s.note("A", "New access tokens and token exchanges stop at once. An API token already exchanged keeps working for at most 60 s (mcp-service cache) and never past its own 5-minute life.", "right")

s.footer = ("How this differs from the web login (auth flows diagram)",
            "The browser gets HttpOnly cookies and Kong verifies the JWT on every call. An MCP host holds a bearer token for a different "
            "audience (/mcp), identifies itself by client metadata URL or registration, shows the user a consent screen with scopes, and "
            "never sends its token to the API: mcp-service exchanges it per call for a one-scope /api token. Access tokens last 15 minutes; "
            "refresh tokens rotate and expire after 24 hours without use.")
s.save("09-mcp-auth-flows")
