"""Authentication and authorization flows in AWS style (six flows, A to F).
Source of truth: services/auth-service, services/kong-gateway (jwt, jwt-scope.lua, jwt-sub.lua), ticketing-mcp-server
Run: python3 05-auth-flows.py"""
from awsdiagram import Sequence
from diagrams.aws.compute import Fargate
from diagrams.aws.database import ElasticacheForRedis
from diagrams.aws.general import Client, User, Users
from diagrams.aws.security import IdentityAndAccessManagementIamEncryptedData as Keychain
from diagrams.onprem.compute import Server
from diagrams.saas.payment import Stripe

P = [
    dict(id="U", icon=Users, label="Customer\nbrowser"),
    dict(id="DEV", icon=User, label="Developer\nterminal"),
    dict(id="CLI", icon=Client, label="Claude / MCP client"),
    dict(id="MCP", icon=Server, label="ticketing-mcp-server\nlocal, stdio"),
    dict(id="KC", icon=Keychain, label="OS Keychain"),
    dict(id="FE", icon=Fargate, label="client\nNext.js SSR"),
    dict(id="K", icon=Fargate, label="kong-gateway"),
    dict(id="AS", icon=Fargate, label="auth-service\nNestJS"),
    dict(id="RD", icon=ElasticacheForRedis, label="ElastiCache Redis\nauth-service"),
    dict(id="DS", icon=Fargate, label="downstream services\norder / ticket / venue / payment"),
    dict(id="ST", icon=Stripe, label="Stripe"),
]
s = Sequence(
    "Authentication and authorization on AWS",
    "RS256 JWT verified once at Kong, scopes enforced at the gateway, mesh-internal gRPC trusted inside the VPC",
    P,
    zones=[("Client side", 0, 4, "amber"), ("Edge + EKS", 5, 7, "blue"), ("Data", 8, 8, "purple"),
           ("Services", 9, 9, "blue"), ("External", 10, 10, "green")],
    spacing=215, margin=150)

# ---------------- Flow A
s.phase("Flow A  -  Browser login: email + password to JWT cookie + refresh token", "amber")
s.m("U", "FE", "GET /signin (SSR page)")
s.m("U", "FE", "POST credentials (Server Action)")
s.m("FE", "K", "POST /auth/login (no JWT required)")
s.m("K", "AS", "forward (rate-limited)")
s.self_("AS", "bcrypt verify, then sign RS256 JWT (15m; sub, email, jti, iss=auth-service)", "data")
s.m("AS", "RD", "SET refresh:<jti> {userId, family} TTL 7d", "data")
s.m("AS", "K", "Set-Cookie access_token (HttpOnly, Secure, SameSite=Lax, 15m) + refresh_token (HttpOnly, path /auth/refresh, 7d)", ret=True)
s.m("K", "FE", "cookies forwarded", ret=True)
s.m("FE", "U", "302 / (logged in)", ret=True)

# ---------------- Flow B
s.phase("Flow B  -  Refresh rotation: access token expired, refresh token still valid", "blue")
s.m("U", "K", "any request returns 401 (JWT expired)")
s.m("FE", "K", "POST /auth/refresh (refresh_token cookie)")
s.m("K", "AS", "forward")
s.m("AS", "RD", "GET refresh:<jti>, validate family, DEL old jti", "data")
s.self_("AS", "issue new JWT + new refresh token (rotated jti, same family)", "data")
s.m("AS", "RD", "SET refresh:<new_jti> TTL 7d", "data")
s.m("AS", "FE", "new cookies", ret=True)
s.note("AS", "Reuse of a revoked refresh token revokes the whole family (token theft detection).", "right")

# ---------------- Flow C
s.phase("Flow C  -  Agent onboarding: OAuth2 Authorization Code + PKCE (RFC 7636)", "purple")
s.m("DEV", "CLI", "claude /mcp authorize ticketing")
s.m("CLI", "MCP", "spawn local MCP server (stdio)")
s.self_("MCP", "generate code_verifier, code_challenge = S256(code_verifier); start loopback listener http://127.0.0.1:19836/callback", "data")
s.m("MCP", "DEV", "print authorize URL (browser opens)", ret=True)
s.m("DEV", "U", "paste / auto-open in browser")
s.m("U", "K", "GET /oauth/authorize?client_id=ticketing-mcp&code_challenge=...&scope=orders:create+...")
s.m("K", "AS", "forward (JWT cookie validated, user must be logged in)")
s.branch("alt", "first-party client (ticketing-mcp)")
s.self_("AS", "auto-approve", "data")
s.branch("else", "dynamic / third-party client")
s.m("AS", "RD", "store PendingConsent (TTL 10m) as request_id", "data")
s.m("AS", "U", "302 /oauth/consent?request_id=...", ret=True)
s.m("U", "FE", "render scope card, user clicks Allow")
s.m("FE", "K", "POST /oauth/consent/<id> (JWT cookie)")
s.m("K", "AS", "forward, resolve consent")
s.m("AS", "RD", "SET oauth:code:<code> {clientId, userId, scope, code_challenge} TTL 600s", "data")
s.m("AS", "U", "302 http://127.0.0.1:19836/callback?code=<code>", ret=True)
s.m("U", "MCP", "browser hits the loopback listener", ret=True)
s.m("MCP", "K", "POST /oauth/token (code, code_verifier, client_id)")
s.m("K", "AS", "forward (no JWT: public endpoint)")
s.m("AS", "RD", "GET + DEL oauth:code:<code>; verify S256(code_verifier) equals stored challenge", "data")
s.m("AS", "RD", "SET refresh:<jti> + oauth:session-scope:<sid> {scope, clientId} TTL 24h", "data")
s.m("AS", "MCP", "{ access_token (15m, +scope +client_id claims), refresh_token, expires_in, scope }", ret=True)
s.m("MCP", "KC", "store tokens in the OS keychain (never on disk)", "data")

# ---------------- Flow D
s.phase("Flow D  -  MCP tool call: Bearer JWT, scope enforced at the gateway", "green")
s.m("DEV", "CLI", '"create order for ticket X"')
s.m("CLI", "MCP", "invoke tool createOrder")
s.m("MCP", "KC", "read access_token", "data")
s.branch("alt", "access_token expired")
s.m("MCP", "K", "POST /oauth/token (grant_type=refresh_token)")
s.m("K", "AS", "forward, rotate, return new tokens")
s.m("AS", "MCP", "new { access_token, refresh_token }", ret=True)
s.m("MCP", "KC", "update keychain", "data")
s.branch("then", "call the API with a valid token")
s.m("MCP", "K", "POST /orders  Authorization: Bearer <jwt>")
s.self_("K", "jwt plugin: verify RS256 via JWKS (kid match), check exp / iss", "data")
s.self_("K", "jwt-scope.lua: require 'orders:create' in token.scope", "data")
s.self_("K", "jwt-sub.lua: inject X-User-Id, X-User-Email, X-Client-Id", "data")
s.m("K", "DS", "forward (mesh-internal, plain HTTP)")
s.m("DS", "K", "201 Created", ret=True)
s.m("K", "MCP", "201", ret=True)
s.m("MCP", "CLI", "tool result", ret=True)

# ---------------- Flow E
s.phase("Flow E  -  Internal gRPC: no JWT, mesh-internal trust boundary", "red")
s.self_("DS", "order-service to ticket-service gRPC ReserveQuota (metadata x-correlation-id, x-user-id propagated)", "grpc")
s.note("DS", "Inside the VPC + EKS NetworkPolicy. Security groups restrict pod-to-pod traffic. No Internet ingress to gRPC ports.", "right")

# ---------------- Flow F
s.phase("Flow F  -  Stripe webhook: signed payload, the signature header replaces the JWT", "teal")
s.m("ST", "K", "POST /payments/webhook  Stripe-Signature: t=..., v1=HMAC_SHA256(body, secret)", "ext")
s.self_("K", "route bypasses the jwt plugin (allowlist), forward", "data")
s.m("K", "DS", "payment-service receives the raw body")
s.self_("DS", "verify HMAC, idempotency on stripe_event_id, UPSERT payment_webhooks", "data")
s.m("DS", "K", "200 OK (must respond in under 5s)", ret=True)

s.footer = ("Token security",
            "Access JWT 15 minutes. Refresh token 7 days for browsers, 24 hours for MCP. RS256 keypair rotated quarterly, "
            "public keys served at /.well-known/jwks.json. Every 4xx/5xx auth failure is audited to CloudWatch and "
            "brute-force attempts are throttled per IP + user.")
s.save("05-auth-flows")
