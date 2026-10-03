"""Authentication and authorization flows in AWS style (four flows, A to D): browser login, refresh rotation, internal gRPC, Stripe webhook.
MCP agent authentication (OAuth 2.1, CIMD) is in 09-mcp-auth-flows.py.
Source of truth: services/auth-service, services/kong-gateway (jwt, jwt-scope.lua, jwt-sub.lua)
Run: python3 05-auth-flows.py"""
from awsdiagram import Sequence
from diagrams.aws.compute import Fargate
from diagrams.aws.database import ElasticacheForRedis
from diagrams.aws.general import Users
from diagrams.saas.payment import Stripe

P = [
    dict(id="U", icon=Users, label="Customer\nbrowser"),
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
    zones=[("Client side", 0, 1, "amber"), ("Edge + EKS", 2, 3, "blue"), ("Data", 4, 4, "purple"),
           ("Services", 5, 5, "blue"), ("External", 6, 6, "green")],
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
s.phase("Flow C  -  Internal gRPC: no JWT, mesh-internal trust boundary", "red")
s.self_("DS", "order-service to ticket-service gRPC ReserveQuota (metadata x-correlation-id, x-user-id propagated)", "grpc")
s.note("DS", "Inside the VPC + EKS NetworkPolicy. Security groups restrict pod-to-pod traffic. No Internet ingress to gRPC ports.", "right")

# ---------------- Flow D
s.phase("Flow D  -  Stripe webhook: signed payload, the signature header replaces the JWT", "teal")
s.m("ST", "K", "POST /payments/webhook  Stripe-Signature: t=..., v1=HMAC_SHA256(body, secret)", "ext")
s.self_("K", "route bypasses the jwt plugin (allowlist), forward", "data")
s.m("K", "DS", "payment-service receives the raw body")
s.self_("DS", "verify HMAC, idempotency on stripe_event_id, UPSERT payment_webhooks", "data")
s.m("DS", "K", "200 OK (must respond in under 5s)", ret=True)

s.footer = ("Token security",
            "Access JWT 15 minutes. Refresh token 7 days. RS256 keypair rotated quarterly, "
            "public keys served at /.well-known/jwks.json. Every 4xx/5xx auth failure is audited to CloudWatch and "
            "brute-force attempts are throttled per IP + user. MCP agents use a different flow: see the MCP authentication diagram.")
s.save("05-auth-flows")
