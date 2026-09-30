"""Data model: database-per-service ownership in AWS style.
Source of truth: services/*/migrations, ticket-service Mongo schemas, expiration-service Redis keys.
Solid lines = enforced foreign keys inside one database.
Orange "-> TABLE" chips = logical references across services (no FK constraint, resolved by gRPC / events).
Run: python3 02-data-model.py"""
from awsdiagram import Canvas, NAVY, GREY, PHASE_COLORS, tw, wrap
from diagrams.aws.compute import Fargate
from diagrams.aws.database import DocumentDB, ElasticacheForRedis, RDSPostgresqlInstance

ORANGE = "#D9730D"
W = 2200
c = Canvas(W, 1900, "Data model on AWS: every service owns exactly one datastore",
           "Solid lines are enforced foreign keys inside one database. Orange chips are logical references across services (no FK).")
c.header()

# ---- table specs: (column, type, key, logical_ref) --------------------------------------
T = {
 "USERS": ([("id", "uuid", "PK"), ("email", "text", "UK"), ("password_hash", "text", ""),
            ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")], ""),
 "USER_PROFILES": ([("user_id", "text", "PK", "USERS"), ("display_name", "text", ""), ("locale", "text", ""),
                    ("timezone", "text", ""), ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")], ""),
 "USER_PREFERENCES": ([("user_id", "text", "PK", "USERS"), ("marketing_opt_in", "bool", ""),
                       ("order_updates", "bool", ""), ("product_updates", "bool", "")], ""),
 "BILLING_ADDRESSES": ([("user_id", "text", "PK", "USERS"), ("line1", "text", ""), ("line2", "text", ""),
                        ("city", "text", ""), ("postal_code", "text", ""), ("country", "text", "")], ""),
 "ORDERS": ([("id", "uuid", "PK"), ("user_id", "uuid", "", "USERS"), ("reservation_id", "uuid", "UK", "ticket-service"),
             ("status", "string", ""), ("total_amount", "decimal", ""), ("version", "int", ""),
             ("expires_at", "timestamptz", ""), ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")],
            "status: PENDING | AWAITING_PAYMENT | CONFIRMED | CANCELLED | EXPIRED. version = optimistic lock."),
 "ORDER_ITEMS": ([("id", "uuid", "PK"), ("order_id", "uuid", "FK"), ("ticket_id", "string", "", "TICKETS"),
                  ("quantity", "int", ""), ("unit_price", "decimal", ""), ("seat_ids", "string", "")],
                 "seat_ids is an optional CSV."),
 "ORDER_OUTBOX": ([("id", "uuid", "PK"), ("aggregate_id", "uuid", ""), ("event_type", "string", ""),
                   ("payload", "jsonb", ""), ("created_at", "timestamptz", ""), ("published_at", "timestamptz", "")],
                  "Transactional outbox. event_type: orders.order.created | cancelled | completed. published_at is NULL until the publisher drains it."),
 "PAYMENTS": ([("id", "uuid", "PK"), ("order_id", "uuid", "UK", "ORDERS"), ("user_id", "uuid", "", "USERS"),
               ("method", "string", ""), ("amount", "decimal", ""), ("currency", "string", ""),
               ("status", "string", ""), ("stripe_payment_intent_id", "string", "UK"),
               ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")],
              "method: CARD | APPLE_PAY | GOOGLE_PAY. status: PENDING | SUCCEEDED | FAILED | REFUNDED."),
 "PAYMENT_RECORDS": ([("id", "uuid", "PK"), ("payment_id", "uuid", "FK"), ("event_type", "string", ""),
                      ("payload", "jsonb", ""), ("recorded_at", "timestamptz", "")],
                     "Audit trail: attempted | succeeded | failed | refunded."),
 "PAYMENT_WEBHOOKS": ([("id", "uuid", "PK"), ("stripe_event_id", "string", "UK"), ("event_type", "string", ""),
                       ("body", "jsonb", ""), ("received_at", "timestamptz", ""), ("processed_at", "timestamptz", "")],
                      "stripe_event_id UNIQUE = webhook idempotency."),
 "TICKETS": ([("id", "string", "PK"), ("title", "string", ""), ("price", "decimal", ""), ("quota", "int", ""),
              ("reserved", "int", ""), ("sold", "int", ""), ("max_per_user", "int", ""),
              ("seating_plan_id", "string", "", "SEATING_PLANS"), ("ticket_type", "string", ""),
              ("event", "jsonb", ""), ("version", "int", ""), ("created_at", "timestamptz", ""),
              ("updated_at", "timestamptz", "")],
             "ticket_type: GA | SEATED_MANUAL | SEATED_AUTO. event holds title, startsAt, endsAt, venue metadata."),
 "RESERVATIONS": ([("id", "string", "PK"), ("ticket_id", "string", "FK"), ("user_id", "string", "", "USERS"),
                   ("quantity", "int", ""), ("status", "string", ""), ("expires_at", "timestamptz", ""),
                   ("created_at", "timestamptz", "")], "status: HELD | FINALIZED | RELEASED | EXPIRED."),
 "EXPIRATION_TIMERS": ([("key", "string", "PK"), ("reservation_id", "string", "", "RESERVATIONS"),
                        ("fires_at", "timestamptz", "")], "Redis ZSET. Polled with ZPOPMIN every second."),
 "VENUES": ([("id", "uuid", "PK"), ("organizer_id", "uuid", ""), ("name", "text", ""), ("capacity", "int", ""),
             ("timezone", "text", ""), ("address", "text", ""), ("created_at", "timestamptz", ""),
             ("updated_at", "timestamptz", "")], ""),
 "VENUE_SECTIONS": ([("id", "uuid", "PK"), ("venue_id", "uuid", "FK"), ("name", "text", ""), ("type", "text", ""),
                     ("row_count", "int", ""), ("column_count", "int", ""), ("position_json", "jsonb", ""),
                     ("display_order", "int", ""), ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")],
                    "Reusable layout template. type: seated | ga."),
 "ORGANIZER_SETTINGS": ([("organizer_id", "uuid", "PK", "VENUES"), ("hold_ttl_sec", "int", ""),
                         ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")],
                        "Per-organizer config. hold_ttl_sec defaults to 600."),
 "SEATING_PLANS": ([("id", "uuid", "PK"), ("venue_id", "uuid", "FK"), ("ticket_id", "uuid", "", "TICKETS"),
                    ("organizer_id", "uuid", ""), ("name", "text", ""), ("status", "text", ""),
                    ("max_seats_per_order", "int", ""), ("assignment_mode", "text", ""), ("pricing_mode", "text", ""),
                    ("layout_json", "jsonb", ""), ("version", "int", ""), ("created_at", "timestamptz", ""),
                    ("updated_at", "timestamptz", "")],
                   "Ticket-first: ticket_id is required at creation. status: draft | active | inactive. assignment: manual | auto. pricing: single | section | seat."),
 "PRICE_TIERS": ([("id", "uuid", "PK"), ("plan_id", "uuid", "FK"), ("name", "text", ""), ("price", "decimal", ""),
                  ("created_at", "timestamptz", "")], ""),
 "SECTIONS": ([("id", "uuid", "PK"), ("plan_id", "uuid", "FK"), ("name", "text", ""), ("type", "text", ""),
               ("row_count", "int", ""), ("column_count", "int", ""), ("price_tier_id", "uuid", "FK"),
               ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")],
              "Event-scoped, cloned from venue_sections."),
 "SEATS": ([("id", "uuid", "PK"), ("section_id", "uuid", "FK"), ("plan_id", "uuid", "FK"),
            ("price_tier_id", "uuid", "FK"), ("seat_label", "text", ""), ("row_label", "text", ""),
            ("column_number", "int", ""), ("status", "text", ""), ("held_by", "uuid", ""),
            ("held_until", "timestamptz", ""), ("attributes", "jsonb", ""), ("version", "int", ""),
            ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")],
           "status: AVAILABLE | HELD | RESERVED | SOLD | BLOCKED. Optional per-seat price_tier_id override."),
 "SEAT_RESERVATIONS": ([("id", "uuid", "PK"), ("plan_id", "uuid", "FK"), ("ticket_id", "uuid", "", "TICKETS"),
                        ("order_id", "uuid", "", "ORDERS"), ("user_id", "uuid", "", "USERS"),
                        ("section_id", "uuid", ""), ("status", "text", ""), ("expires_at", "timestamptz", ""),
                        ("created_at", "timestamptz", ""), ("updated_at", "timestamptz", "")],
                       "Durable reservation ledger. status: RESERVED | RELEASED | SOLD | EXPIRED. order_id is set after order creation."),
 "SEAT_RESERVATION_ITEMS": ([("reservation_id", "uuid", "FK"), ("seat_id", "uuid", "FK"), ("section_id", "uuid", "FK"),
                             ("price", "decimal", ""), ("seat_label", "text", "")],
                            "One row per seat. price is a snapshot at reservation time."),
}

CW, GAP = 350, 46           # card width, group gap
ROW, HDR = 18, 30
GX0 = 40
cards = {}                  # name -> (x, y, w, h)


def card(name, x, y):
    cols, note = T[name]
    nl = wrap(note, CW - 20, 10) if note else []
    h = HDR + len(cols) * ROW + 10 + (len(nl) * 13 + 8 if nl else 0)
    c.rect(x, y, CW, h, "#3B48CC", "white", "", 1.4, 6)
    c.add(f'<path d="M{x},{y + 6} a6,6 0 0 1 6,-6 h{CW - 12} a6,6 0 0 1 6,6 v{HDR - 6} h-{CW} z" fill="#3B48CC"/>')
    c.text(x + 12, y + 20, name, 13, "bold", "white", "start")
    yy = y + HDR + 4
    for col in cols:
        cn, ct, ck = col[0], col[1], col[2]
        ref = col[3] if len(col) > 3 else None
        if ck:
            colr = {"PK": "#B7791F", "FK": "#1B6EC2", "UK": "#6D3FD0"}[ck]
            c.rect(x + 8, yy + 2, 26, 13, colr, "white", "", 1, 3)
            c.text(x + 21, yy + 12, ck, 9, "bold", colr)
        c.text(x + 40, yy + 12, cn, 11.5, "bold" if ck == "PK" else "normal", NAVY, "start")
        c.text(x + 196, yy + 12, ct, 10.5, "normal", GREY, "start")
        if ref:
            c.text(x + CW - 8, yy + 12, "-> " + ref, 10.5, "bold", ORANGE, "end")
        yy += ROW
    if nl:
        c.text(x + 10, yy + 12, "\n".join(nl), 10, "normal", GREY, "start", True, 13)
    cards[name] = (x, y, CW, h)
    return h


def group(x, y, title, sub, tables, color, icon_cls, cols=1, split=None):
    """draw a datastore group holding the given tables; returns bottom y"""
    # measure
    def h_of(n):
        cols_, note = T[n]
        nl = wrap(note, CW - 20, 10) if note else []
        return HDR + len(cols_) * ROW + 10 + (len(nl) * 13 + 8 if nl else 0)
    colsets = split or [tables]
    heights = [sum(h_of(n) for n in cs) + 24 * (len(cs) - 1) for cs in colsets]
    gw = (CW + 32) * len(colsets) + 24 * (len(colsets) - 1)
    gh = 70 + max(heights) + 16
    c.rect(x, y, gw, gh, color, "#FBFCFE", "", 2, 10)
    c.text(x + 16, y + 28, title, 17, "bold", NAVY, "start")
    c.text(x + 16, y + 48, sub, 12, "normal", GREY, "start")
    c.icon(x + gw - 40, y + 32, icon_cls, "", 40)
    for i, cs in enumerate(colsets):
        cx = x + 16 + i * (CW + 32 + 24)
        cy = y + 70
        for n in cs:
            cy += card(n, cx, cy) + 24
    return y + gh, gw


# ---- domain headers + groups ------------------------------------------------------------
top = 105
def domain(x, w, label, colour):
    bg, fg = PHASE_COLORS[colour]
    c.rect(x, top, w, 34, fg, bg, "", 1.4, 8)
    c.text(x + w / 2, top + 22, label, 15, "bold", fg)

col1 = GX0
col2 = col1 + CW + 32 + GAP
col3 = col2 + CW + 32 + GAP
col4 = col3 + CW + 32 + GAP
w1 = CW + 32
domain(col1, w1, "Identity", "amber")
domain(col2, w1, "Transaction", "blue")
domain(col3, w1, "Catalog: tickets", "green")
domain(col4, 2 * (CW + 32) + 24, "Catalog: venues and seating", "green")

gy = top + 50
b1, _ = group(col1, gy, "auth_db", "RDS PostgreSQL 16  |  owned by auth-service", ["USERS"], "#1B6EC2", RDSPostgresqlInstance)
group(col1, b1 + 26, "user_db", "RDS PostgreSQL 16  |  owned by user-service",
      ["USER_PROFILES", "USER_PREFERENCES", "BILLING_ADDRESSES"], "#1B6EC2", RDSPostgresqlInstance)
b2, _ = group(col2, gy, "order_db", "RDS PostgreSQL 16  |  owned by order-service",
              ["ORDERS", "ORDER_ITEMS", "ORDER_OUTBOX"], "#1B6EC2", RDSPostgresqlInstance)
group(col2, b2 + 26, "payment_db", "RDS PostgreSQL 16  |  owned by payment-service",
      ["PAYMENTS", "PAYMENT_RECORDS", "PAYMENT_WEBHOOKS"], "#1B6EC2", RDSPostgresqlInstance)
b3, _ = group(col3, gy, "ticket_db", "DocumentDB (MongoDB API)  |  owned by ticket-service",
              ["TICKETS", "RESERVATIONS"], "#3F8624", DocumentDB)
b3b, _ = group(col3, b3 + 26, "Redis timers", "ElastiCache Redis  |  owned by expiration-service",
               ["EXPIRATION_TIMERS"], "#C7254E", ElasticacheForRedis)
b4, gw4 = group(col4, gy, "venue_db", "RDS PostgreSQL 16  |  owned by venue-service", None, "#1B6EC2", RDSPostgresqlInstance,
                split=[["VENUES", "VENUE_SECTIONS", "ORGANIZER_SETTINGS", "SEAT_RESERVATIONS", "SEAT_RESERVATION_ITEMS"],
                       ["SEATING_PLANS", "SECTIONS", "SEATS", "PRICE_TIERS"]])


# ---- enforced FK lines (inside one database) --------------------------------------------
def fk(a, b, label="1:N", lane=0):
    xa, ya, wa, ha = cards[a]
    xb, yb, wb, hb = cards[b]
    if abs(xa - xb) < 1:  # same column, use left gutter
        gx = xa - 9 - lane * 6
        pts = [(xa, ya + HDR / 2 + lane * 4), (gx, ya + HDR / 2 + lane * 4), (gx, yb + HDR / 2), (xb, yb + HDR / 2)]
        lp = (gx, (ya + yb) / 2)
    else:  # neighbouring columns inside the venue group
        left, right = (a, b) if xa < xb else (b, a)
        xl, yl, wl, hl = cards[left]
        xr, yr, wr, hr = cards[right]
        gx = xl + wl + 16 + lane * 6
        pts = [(xl + wl, yl + HDR / 2 + 6 + lane * 4), (gx, yl + HDR / 2 + 6 + lane * 4), (gx, yr + HDR / 2 + 6), (xr, yr + HDR / 2 + 6)]
        pts = pts if a == left else pts[::-1]
        lp = (gx, (yl + yr) / 2)
    c.line(pts, "#3B48CC", sw=1.8, head=True, tail=False, label=label, lpos=lp, lsize=10)


fk("ORDER_ITEMS", "ORDERS", "N:1")
fk("ORDER_OUTBOX", "ORDERS", "N:1", 1)
fk("PAYMENT_RECORDS", "PAYMENTS", "N:1")
fk("PAYMENT_WEBHOOKS", "PAYMENTS", "N:1", 1)
fk("RESERVATIONS", "TICKETS", "N:1")
fk("VENUE_SECTIONS", "VENUES", "N:1")
fk("SEAT_RESERVATION_ITEMS", "SEAT_RESERVATIONS", "N:1")
fk("SECTIONS", "SEATING_PLANS", "N:1")
fk("SEATS", "SECTIONS", "N:1")
fk("PRICE_TIERS", "SEATING_PLANS", "N:1", 1)
fk("SEATING_PLANS", "VENUES", "N:1")
fk("SEAT_RESERVATIONS", "SEATING_PLANS", "N:1", 1)

# ---- footer -----------------------------------------------------------------------------
fy = max(b1, b2, b3b, b4) + 300
end = max(cards[n][1] + cards[n][3] for n in cards) + 60
c.callout(GX0, end, W - 2 * GX0, "Production takeaway",
          "Each service owns exactly one datastore and no query crosses a service boundary (AGENTS.md rule 4: own your data). "
          "The orange references are resolved through gRPC calls and Kafka events, not joins, so services deploy and scale "
          "independently. Consistency across them is eventual and driven by the outbox pattern; the authoritative gate for "
          "stock is the reservation, not the index or the read model.", "#232F3E", "#F3F5F8", 13)
c.h = end + 150
c.line([(700, c.h - 45), (740, c.h - 45)], "#3B48CC", sw=2, head=False)
c.text(748, c.h - 40, "enforced foreign key (same database)", 12, "normal", NAVY, "start")
c.text(1060, c.h - 40, "-> TABLE", 12, "bold", ORANGE, "start")
c.text(1130, c.h - 40, "logical reference to another service's data (no FK)", 12, "normal", NAVY, "start")
c.text(1560, c.h - 40, "PK primary key | FK foreign key | UK unique", 12, "normal", GREY, "start")
c.save("02-data-model")
