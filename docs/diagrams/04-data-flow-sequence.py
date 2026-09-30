"""Reservation + payment saga (happy path and compensation) in AWS style.
Source of truth: services/*/internal/kafka, proto/, docs/04-asynchronous-messaging.md
Run: python3 04-data-flow-sequence.py"""
from awsdiagram import Sequence
from diagrams.aws.analytics import ManagedStreamingForKafka
from diagrams.aws.compute import Fargate
from diagrams.aws.database import ElasticacheForRedis
from diagrams.aws.general import Users
from diagrams.saas.payment import Stripe

P = [
    dict(id="U", icon=Users, label="Customer"),
    dict(id="K", icon=Fargate, label="kong-gateway"),
    dict(id="OS", icon=Fargate, label="order-service\nJava | Spring Boot"),
    dict(id="TS", icon=Fargate, label="ticket-service\nGo"),
    dict(id="VS", icon=Fargate, label="venue-service\nGo"),
    dict(id="PS", icon=Fargate, label="payment-service\nNestJS"),
    dict(id="ES", icon=Fargate, label="expiration-service\nGo"),
    dict(id="MQ", icon=ManagedStreamingForKafka, label="Amazon MSK\nKafka"),
    dict(id="RD", icon=ElasticacheForRedis, label="ElastiCache Redis\ntimers (ZSET)"),
    dict(id="ST", icon=Stripe, label="Stripe"),
]
s = Sequence(
    "Reservation + payment saga on AWS",
    "Reserve with gRPC, hand off with Kafka + transactional outbox, finalize on payment, compensate on expiry",
    P,
    zones=[("Client", 0, 0, "amber"), ("Edge", 1, 1, "teal"), ("EKS: ticketing namespace", 2, 6, "blue"),
           ("Messaging + cache", 7, 8, "purple"), ("External", 9, 9, "green")],
    spacing=225, margin=150)

# ---------------- Phase 1
s.phase("Phase 1  -  Reserve quota and seats (synchronous, gRPC)", "amber")
s.m("U", "K", "POST /orders (ticket_id, qty, optional seat_ids)")
s.m("K", "OS", "JWT verified, forward")
s.m("OS", "TS", "gRPC ReserveQuota(ticket_id, reservation_id, qty, expires_at +15m)", "grpc")
s.m("TS", "OS", "success, remaining, price, max_per_user", "grpc", ret=True)
s.branch("alt", "specific seats requested")
s.m("OS", "VS", "gRPC ReserveHeldSeats(plan_id, seat_ids)", "grpc")
s.m("VS", "OS", "success, seats[]", "grpc", ret=True)
s.branch("else", "auto-assign")
s.m("OS", "VS", "gRPC AutoAssignAndReserve(plan_id, section, qty)", "grpc")
s.m("VS", "OS", "success, seats[]", "grpc", ret=True)
s.self_("OS", "INSERT orders (status=PENDING, expires_at) AND INSERT order_outbox in one DB transaction (Spring @Transactional)", "data")
s.note("OS", "Transactional outbox: the order and its event commit atomically, so no event is lost or invented.", "right")
s.m("OS", "K", "201 Created (order_id, expires_at)", ret=True)
s.m("K", "U", "201 Created", ret=True)

# ---------------- Phase 2
s.phase("Phase 2  -  Outbox drain to Kafka (CloudEvents envelope)", "blue")
s.m("OS", "MQ", "publish orders.order.created (key=order_id, partitioned by user_id)", "kafka")
s.branch("par", "expiration timer scheduled")
s.m("MQ", "ES", "consume orders.order.created", "kafka", ret=True)
s.m("ES", "RD", "ZADD timers fires_at reservation_id", "data")
s.branch("and", "payment picks up")
s.m("MQ", "PS", "consume orders.order.created", "kafka", ret=True)
s.self_("PS", "INSERT payments (status=PENDING, idempotency=order_id)", "data")

# ---------------- Phase 3
s.phase("Phase 3  -  Client confirms payment", "purple")
s.m("U", "K", "POST /payments/confirm (order_id, payment_method)")
s.m("K", "PS", "JWT verified, forward")
s.m("PS", "ST", "create + confirm PaymentIntent (amount, currency)", "ext")
s.m("ST", "PS", "status=succeeded (or requires_action)", "ext", ret=True)
s.self_("PS", "UPDATE payments SET status=SUCCEEDED AND INSERT payment_records", "data")
s.m("PS", "MQ", "publish payments.payment.succeeded (CloudEvents)", "kafka")
s.m("ST", "K", "webhook payment_intent.succeeded (async, idempotent)", "ext")
s.m("K", "PS", "POST /payments/webhook (signature verified, dedupe on stripe_event_id)")

# ---------------- Phase 4
s.phase("Phase 4  -  Finalize quota and complete the order", "green")
s.m("MQ", "OS", "consume payments.payment.succeeded", "kafka", ret=True)
s.m("OS", "TS", "gRPC FinalizeReservation(reservation_id, order_id)", "grpc")
s.m("TS", "OS", "success", "grpc", ret=True)
s.m("OS", "VS", "gRPC FinalizeSeatReservation(reservation_id, order_id)", "grpc")
s.m("VS", "OS", "success", "grpc", ret=True)
s.self_("OS", "UPDATE orders SET status=CONFIRMED AND outbox (orders.order.completed)", "data")
s.m("OS", "MQ", "publish orders.order.completed", "kafka")
s.m("MQ", "ES", "consume orders.order.completed (cancel timer)", "kafka", ret=True)
s.m("ES", "RD", "ZREM timers reservation_id", "data")

# ---------------- Phase 5
s.phase("Phase 5  -  Expiry path (compensating saga)", "red")
s.m("ES", "RD", "ZPOPMIN expired timers (every 1s)", "data")
s.m("ES", "MQ", "publish expiration.order.expiration_complete", "kafka")
s.m("MQ", "OS", "consume expiration.order.expiration_complete", "kafka", ret=True)
s.branch("alt", "order still PENDING or AWAITING_PAYMENT")
s.m("OS", "TS", "gRPC ReleaseReservation(reservation_id, reason=EXPIRED)", "grpc")
s.m("OS", "VS", "gRPC ReleaseSeatReservation(reservation_id, reason=EXPIRED)", "grpc")
s.self_("OS", "UPDATE orders SET status=EXPIRED", "data")
s.m("OS", "MQ", "publish orders.order.cancelled", "kafka")
s.m("MQ", "PS", "consume orders.order.cancelled (void intent)", "kafka", ret=True)
s.m("PS", "ST", "cancel PaymentIntent (if not captured)", "ext")
s.branch("else", "already CONFIRMED")
s.note("OS", "No-op: the handler is idempotent.", "right")

s.footer = ("Production takeaway",
            "Every consumer failure retries with exponential back-off (max 3), then routes to <topic>.dlq. "
            "Messages are audited and never silently dropped. The saga has no distributed lock: quota and seats are "
            "held with a TTL, finalized only after payment succeeds, and released by the expiration timer otherwise.")
s.save("04-data-flow-sequence")
