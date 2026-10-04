"""Virtual waiting room (onsale surge gate) in AWS style.
Source of truth: services/queue-service (.NET 10, own domain + Redis), client connector (proxy.ts), Kong backstop.
Run: python3 06-waiting-room-flow.py"""
from awsdiagram import Sequence
from diagrams.aws.compute import Fargate
from diagrams.aws.database import ElasticacheForRedis
from diagrams.aws.general import Users

P = [
    dict(id="B", icon=Users, label="Buyer\nbrowser"),
    dict(id="C", icon=Fargate, label="Connector\nNext.js proxy.ts"),
    dict(id="Q", icon=Fargate, label="queue-service\n.NET 10, queue.* domain"),
    dict(id="R", icon=ElasticacheForRedis, label="Queue Redis\nseparate from app Redis"),
    dict(id="K", icon=Fargate, label="Kong + ticket-service\nbackstop"),
]
s = Sequence(
    "Virtual waiting room for an onsale surge",
    "A fair draw, then admission by pure time-math, then a pass bound to one account that Kong re-checks",
    P,
    zones=[("Client", 0, 0, "amber"), ("Front door (EKS)", 1, 1, "blue"), ("Queue subsystem (own domain + Redis)", 2, 3, "pink"),
           ("Buy path", 4, 4, "teal")],
    spacing=330, margin=190)

s.phase("Phase 1  -  Gate armed: buyer is sent to the queue", "amber")
s.note("C", "onsale armed (QUEUE_GATE_ARMED=true)", "right")
s.m("B", "C", "GET /tickets/123")
s.m("C", "B", "302 to queue/wait?e=E&target=/tickets/123 (no valid pass)", ret=True)

s.phase("Phase 2  -  Pre-queue fair draw, then wait", "pink")
s.m("B", "Q", "GET /wait (page only, joins nothing)")
s.m("B", "Q", "POST /api/enqueue (from the page script, rate-limited per IP)")
s.m("Q", "R", "ZADD prequeue (random score = fair draw, arrival time does not matter)", "data")
s.m("Q", "B", "ticket cookie; the page counts down and polls", ret=True)
s.branch("loop", "until position < serving")
s.m("B", "Q", "GET /serving (cacheable, pure time-math)")
s.m("Q", "B", "serving = floor(rate * (now - T0))", ret=True)

s.phase("Phase 3  -  Admission: a pass bound to one account", "green")
s.m("B", "Q", "POST /claim")
s.m("Q", "B", "signed admission token (HMAC, single-use nonce, no account yet)", ret=True)
s.m("B", "C", "302 to /tickets/123?qpass={token}")
s.branch("alt", "not logged in")
s.m("C", "B", "302 to /auth/signin?next=/tickets/123?qpass={token}", ret=True)
s.m("B", "C", "sign in, back to /tickets/123?qpass={token}")
s.m("C", "K", "POST /api/queue/redeem (login token)")
s.m("K", "Q", "/api/redeem + X-User-Id and its HMAC signature")
s.note("Q", "binds the queue place to the first account; one pass per account per event", "right")
s.m("Q", "C", "pass (Sub = account, 15 min); the same pass again on a repeat", ret=True)
s.m("C", "B", "set qq_pass cookie, 302 /tickets/123 (clean URL)", ret=True)

s.phase("Phase 4  -  Purchase writes with a second check", "teal")
s.m("B", "K", "hold seats / create order (qq_pass cookie)")
s.note("K", "Kong re-checks the pass: signature, expiry, event, and that its Sub is the caller. Payment and release are never gated.", "right")
s.m("K", "B", "held", ret=True)

s.footer = ("Production takeaway",
            "The queue is a standalone subsystem on its own domain and Redis, so a traffic surge on the queue cannot starve the "
            "order path. /serving is pure arithmetic on time and rate, so it is cacheable at the CDN and needs no per-user "
            "state. The pass is HMAC-signed and bound to the account that redeemed it, so it cannot be resold or shared, and "
            "it is checked twice: at the connector and again at Kong.")
s.save("06-waiting-room-flow")
