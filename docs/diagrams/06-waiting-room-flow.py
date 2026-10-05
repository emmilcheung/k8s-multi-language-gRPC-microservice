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
    dict(id="V", icon=Fargate, label="venue-service\nseat availability"),
]
s = Sequence(
    "Virtual waiting room for an onsale surge",
    "A fair draw, then rate-based admission that freezes while paused, then a pass bound to one account that Kong re-checks",
    P,
    zones=[("Client", 0, 0, "amber"), ("Front door (EKS)", 1, 1, "blue"), ("Queue subsystem (own domain + Redis)", 2, 3, "pink"),
           ("Buy path", 4, 4, "teal"), ("Venue (seat counts)", 5, 5, "green")],
    spacing=330, margin=190)

s.phase("Phase 1  -  Gate armed: buyer is sent to the queue", "amber")
s.note("C", "onsale armed (QUEUE_GATE_ARMED=true). Only the armed event's own page and its seats and plans pages are gated; orders and checkout stay open.", "right")
s.m("B", "C", "GET /tickets/123")
s.m("C", "B", "302 to queue/wait?e=E&target=/tickets/123 (no valid pass)", ret=True)

s.phase("Phase 2  -  Pre-queue fair draw, then wait", "pink")
s.m("B", "Q", "GET /wait (page only, joins nothing)")
s.m("B", "Q", "POST /api/enqueue (from the page script, rate-limited per IP)")
s.m("Q", "R", "ZADD prequeue (random score = fair draw, arrival time does not matter)", "data")
s.m("Q", "B", "ticket cookie; the page counts down and polls", ret=True)
s.branch("loop", "until position < serving")
s.m("B", "Q", "GET /serving (cacheable)")
s.note("Q", "Each pod keeps a per-event snapshot for 1 s. If Redis errors it serves the last snapshot for up to 10 s. A claim always waits for fresh data.", "right")
s.m("Q", "R", "read the event config hash (at most once a second per pod per event)", "data")
s.m("Q", "B", "serving = servingBase + floor(rate * (now - tBase)); frozen while the operator or the venue has paused", ret=True)
s.branch("par", "venue polling, in the background")
s.m("Q", "V", "GET /internal/tickets/E/availability (at most every 2 s per event)")
s.m("V", "Q", "seats free and seats held", ret=True)
s.note("Q", "No seats free but some held = paused. None free and none held = sold out. Either sets the shared venuePaused flag in the config hash, which freezes serving. Only a pod with a fresh reading may change it. If no pod refreshes it for 30 s it lapses, and serving resumes from the moment it is cleared, without a jump.", "right")
s.note("Q", "The operator API (rate, paused, sold-out) runs on a separate admin port, not the public one.", "right")

s.phase("Phase 3  -  Admission: a pass bound to one account", "green")
s.m("B", "Q", "POST /claim")
s.branch("alt", "event paused or sold out")
s.m("Q", "B", "409; the waiting page shows paused or sold out, or \"couldn't confirm your place\" with a retry", ret=True)
s.branch("else", "admitted")
s.m("Q", "B", "signed admission token (HMAC, single-use nonce, no account yet)", ret=True)
s.m("B", "C", "302 to /tickets/123?qpass={token}")
s.branch("alt", "not logged in")
s.m("C", "B", "302 to /auth/signin?next=/tickets/123 (token kept in the short-lived qq_admit cookie, not in the URL)", ret=True)
s.m("B", "C", "sign in, back to /tickets/123 (qq_admit cookie sent)")
s.m("C", "K", "POST /api/queue/redeem (login token)")
s.m("K", "Q", "/api/redeem + X-User-Id and its HMAC signature")
s.note("Q", "binds the queue place to the first account; one pass per account per event", "right")
s.m("Q", "C", "pass (Sub = account, 15 min); the same pass again on a repeat", ret=True)
s.branch("alt", "redeem fails")
s.m("C", "B", "302 back to the queue page (queue/wait?e=E&target=...); qq_admit cleared", ret=True)
s.branch("else", "redeemed")
s.m("C", "B", "set qq_pass cookie, clear qq_admit, 302 /tickets/123 (clean URL)", ret=True)

s.phase("Phase 4  -  Purchase writes with a second check", "teal")
s.m("B", "K", "hold seats / create order (qq_pass cookie)")
s.note("K", "Kong re-checks the pass: signature, expiry, event, and that its Sub is the caller. Payment and release are never gated.", "right")
s.m("K", "B", "held", ret=True)

s.footer = ("Production takeaway",
            "The queue is a standalone subsystem on its own domain and Redis, so a traffic surge on the queue cannot starve the "
            "order path. /serving is arithmetic on a stored base, the time and the rate, so it is cacheable at the CDN and needs no per-user "
            "state. The pass is HMAC-signed and bound to the account that redeemed it, so it cannot be resold or shared, and "
            "it is checked twice: at the connector and again at Kong.")
s.save("06-waiting-room-flow")
