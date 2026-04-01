# Quota-Based Ticket Reservation System — Detailed Design Document

**Status:** REVISED — implementation-ready baseline after architecture review 2026-04-01  
**Author:** Principal Engineer (Agent)  
**Date:** 2026-04-01  
**Scope:** ticket-service, order-service, proto, client  

---

## 1. Executive Summary

Transform the current **1 ticket = 1 purchasable unit** model into a **1 ticket = N-seat quota** model for non-seated inventory.

This revision intentionally replaces the earlier pure-counter design with a **counter + reservation ledger** model because purchase inventory must be correct under retries, duplicate Kafka delivery, process crashes, and partial failures.

### V1 Outcome

- A ticket has `quota`, `reserved`, `sold`, `maxPerUser`, and `available = quota - reserved - sold`.
- Reservation is a **synchronous gRPC write** from `order-service` to `ticket-service`.
- The hot path still uses **Redis Lua** for atomic availability checks.
- Every successful reservation also creates a **durable reservation record** keyed by `reservationId` before success is returned.
- Cancellation and completion operate by `reservationId`, not only by `ticketId + quantity`.
- The design is **idempotent** for retries and Kafka redelivery.
- The existing `orderId` field on tickets is removed because quota tickets are no longer a 1:1 reservation model.

### Why This Revision Exists

The previous draft had several production risks:

- duplicate `orders.order.cancelled` or `orders.order.completed` events could corrupt counters
- per-user limit enforcement was race-prone because it happened after reservation
- Redis was temporarily treated as authoritative without enough durable reservation identity
- the Redisson lock strategy was inconsistent across sections

This revision resolves those issues while keeping the high-throughput Redis gate.

---

## 2. Current Architecture (Baseline)

### Ticket Model (MongoDB)

Current `ticket-service` stores a ticket as:

```go
type Ticket struct {
    ID        string    `bson:"_id"`
    Title     string    `bson:"title"`
    Price     float64   `bson:"price"`
    UserID    string    `bson:"userId"`
    OrderID   string    `bson:"orderId,omitempty"`
    Version   int       `bson:"version"`
    CreatedAt time.Time `bson:"createdAt"`
    UpdatedAt time.Time `bson:"updatedAt"`
}
```

### Current Reservation Flow

```text
POST /api/orders -> order-service
  1. Acquire Redisson lock on ticketId
  2. gRPC ValidateTicketAvailability -> ticket-service checks orderId == ""
  3. DB guard in order-service rejects another active order for same ticket
  4. Create order + outbox in PostgreSQL
  5. Publish orders.order.created
  6. ticket-service Kafka consumer sets ticket.orderId
```

### Current Problem

The reservation is asynchronous and 1:1. It does not support:

- multi-quantity purchases
- immediate sold-out feedback at quota scale
- multiple active orders for the same ticket up to quota
- safe idempotent release/finalize operations

---

## 3. Target Architecture

### 3.1 Ticket Inventory Model

```go
type Ticket struct {
    ID         string    `bson:"_id"`
    Title      string    `bson:"title"`
    Price      string    `bson:"price"` // decimal string; migrate from float during implementation
    UserID     string    `bson:"userId"`
    Quota      int       `bson:"quota"`
    Reserved   int       `bson:"reserved"`
    Sold       int       `bson:"sold"`
    MaxPerUser int       `bson:"maxPerUser"`
    Version    int       `bson:"version"`
    CreatedAt  time.Time `bson:"createdAt"`
    UpdatedAt  time.Time `bson:"updatedAt"`
}
```

Rules:

- `quota >= 1`
- `reserved >= 0`
- `sold >= 0`
- `reserved + sold <= quota`
- `maxPerUser >= 1`

### 3.2 Reservation Ledger

Add a new MongoDB collection owned by `ticket-service`:

```go
type TicketReservation struct {
    ID            string     `bson:"_id"`           // reservationId (UUID)
    TicketID      string     `bson:"ticketId"`
    OrderID       string     `bson:"orderId,omitempty"`
    UserID        string     `bson:"userId"`
    Quantity      int        `bson:"quantity"`
    Status        string     `bson:"status"`        // RESERVED | RELEASED | SOLD | EXPIRED
    ExpiresAt     *time.Time `bson:"expiresAt,omitempty"`
    CreatedAt     time.Time  `bson:"createdAt"`
    UpdatedAt     time.Time  `bson:"updatedAt"`
}
```

Why this exists:

- makes `ReleaseReservation` and `FinalizeReservation` idempotent
- gives a durable link between counters and orders
- supports reconciliation and operational recovery
- lets `ticket-service` enforce per-user reservation caps atomically

### 3.3 Ownership Boundaries

`ticket-service` owns:

- quota inventory counters
- quota reservation ledger
- sold-out and per-user purchase enforcement for GA tickets

`order-service` owns:

- order creation and lifecycle
- outbox event production
- order read model for clients

### 3.4 Reservation Flow

```text
POST /api/orders -> order-service
  1. Generate reservationId (UUID)
  2. gRPC ReserveQuota(ticketId, reservationId, userId, quantity, reservationExpiresAt)
  3. ticket-service atomically checks quota and per-user limit
  4. ticket-service decrements Redis availability
  5. ticket-service writes durable reservation row + updates Mongo ticket counters
  6. ticket-service returns reservation details
  7. order-service creates order + outbox within one DB transaction
  8. order-service stores reservationId on the order
  9. if DB transaction fails, order-service synchronously calls ReleaseReservation(reservationId)
```

### 3.5 Finalization Flow

```text
On order cancellation / expiration:
  orders.order.cancelled -> ticket-service consumer
    -> ReleaseReservation(reservationId)

On payment capture:
  orders.order.completed -> ticket-service consumer
    -> FinalizeReservation(reservationId, orderId)
```

Both operations are idempotent:

- releasing an already released reservation is success
- finalizing an already sold reservation is success
- releasing a sold reservation is a no-op success

---

## 4. Core Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Reservation API | synchronous gRPC | immediate purchase feedback |
| Hot path gate | Redis Lua | atomic, low latency |
| Durability | Mongo ticket + reservation collections | inventory correctness and recoverability |
| Idempotency key | `reservationId` | safe retries and Kafka redelivery |
| Per-user limit enforcement | inside `ticket-service` reserve path | removes cross-service race |
| Order-service distributed lock | remove from target design | atomicity belongs in inventory owner, not application lock |
| Deprecated availability RPC | keep temporarily but compute full `available = quota - reserved - sold` | backward compatibility during rollout |
| Money format | decimal string in gRPC/events | avoid float drift on purchase paths |

---

## 5. Redis Design

### 5.1 Key Structure

Use Redis hash tags so the design remains compatible with Redis Cluster.

```text
ticket-service:{ticketId}:available                  -> STRING int
ticket-service:{ticketId}:user-reserved:{userId}    -> STRING int
```

Notes:

- Both keys share the `{ticketId}` hash tag and can participate in one Lua script.
- Keys are persistent inventory keys by design. This is one of the rare intentional exceptions to the default TTL guideline.

### 5.2 Reserve Lua Script

Inputs:

- availability key
- per-user reserved key
- requested quantity
- maxPerUser

Behavior:

1. fail if `available < quantity`
2. fail if `userReserved + quantity > maxPerUser`
3. decrement availability
4. increment user reserved count
5. return remaining inventory

### 5.3 Release / Finalize Lua Scripts

`ReleaseReservation`:

- increments availability
- decrements per-user reserved count

`FinalizeReservation`:

- decrements per-user reserved count only
- does not change availability because the quantity was already removed at reserve time

These scripts are only executed after the reservation ledger state transition is validated.

---

## 6. gRPC Contract

```protobuf
service TicketService {
  rpc GetTicket(GetTicketRequest) returns (GetTicketResponse);
  rpc ValidateTicketAvailability(ValidateTicketRequest) returns (ValidateTicketResponse); // deprecated
  rpc ReserveQuota(ReserveQuotaRequest) returns (ReserveQuotaResponse);
  rpc ReleaseReservation(ReleaseReservationRequest) returns (ReleaseReservationResponse);
  rpc FinalizeReservation(FinalizeReservationRequest) returns (FinalizeReservationResponse);
}

message ReserveQuotaRequest {
  string ticket_id = 1;
  string reservation_id = 2;
  string user_id = 3;
  int32 quantity = 4;
  google.protobuf.Timestamp expires_at = 5;
}

message ReserveQuotaResponse {
  bool success = 1;
  string reservation_id = 2;
  string ticket_id = 3;
  int32 quantity = 4;
  int32 remaining = 5;
  string title = 6;
  string price = 7;
  int32 max_per_user = 8;
}

message ReleaseReservationRequest {
  string reservation_id = 1;
  string reason = 2; // CANCELLED | EXPIRED | COMPENSATION
}

message ReleaseReservationResponse {
  bool success = 1;
  string reservation_id = 2;
  int32 remaining = 3;
}

message FinalizeReservationRequest {
  string reservation_id = 1;
  string order_id = 2;
}

message FinalizeReservationResponse {
  bool success = 1;
  string reservation_id = 2;
}
```

Notes:

- all write RPCs use explicit deadlines
- `reservation_id` is caller-generated so retries are safe
- `order_id` is only required once an order exists

---

## 7. Order-Service Changes

### 7.1 Order Model

Add `reservationId` and `quantity` to `Order`.

```text
orders
  id
  user_id
  ticket_id
  reservation_id
  quantity
  status
  expires_at
  version
```

### 7.2 CreateOrderRequest

```java
public class CreateOrderRequest {
    @NotBlank
    private String ticketId;

    @Min(1)
    private int quantity = 1;
}
```

### 7.3 Order Creation Flow

```text
1. order-service generates reservationId
2. reserve via gRPC
3. if reserve fails -> return 409 or 422
4. create order + outbox in one transaction
5. if transaction fails -> ReleaseReservation(reservationId, COMPENSATION)
```

### 7.4 Redisson

Remove Redisson from the target purchase path.

Reason:

- platform guidance prefers data-store concurrency control over application-level distributed locks
- the inventory owner now enforces atomicity directly
- keeping both mechanisms adds latency and creates inconsistent failure modes

Redisson can remain temporarily during rollout only if the team wants a short-lived migration safety flag, but it is not part of the target architecture.

---

## 8. Ticket-Service Data Changes

### 8.1 Ticket Collection Migration

Target fields:

- remove `orderId`
- add `quota`, `reserved`, `sold`, `maxPerUser`

Migration strategy:

1. backfill all tickets with default `quota=1`, `reserved=0`, `sold=0`, `maxPerUser=1`
2. for tickets currently reserved by `orderId`, backfill a matching `TicketReservation` row with `quantity=1`, `status=RESERVED`
3. after all code paths stop reading `orderId`, remove it from documents and indexes

Do not use duplicate keys in Mongo filters. Example migration shape:

```javascript
db.tickets.updateMany(
  { quota: { $exists: false } },
  { $set: { quota: 1, reserved: 0, sold: 0, maxPerUser: 1 } }
)
```

### 8.2 Reservation Collection Indexes

Required indexes:

- `{ ticketId: 1, status: 1 }`
- `{ userId: 1, ticketId: 1, status: 1 }`
- `{ orderId: 1 }` sparse
- `{ expiresAt: 1 }` for reconciliation / expiry sweep

---

## 9. Event Schema Changes

### 9.1 Order Events

`orders.order.created` data adds:

- `reservationId`
- `quantity`

`orders.order.cancelled` data adds:

- `reservationId`
- `quantity`

`orders.order.completed` is added with:

- `orderId`
- `ticketId`
- `reservationId`
- `quantity`
- `version`

These events remain CloudEvents v1.0.

### 9.2 Ticket Events

`tickets.ticket.created` and `tickets.ticket.updated` add:

- `quota`
- `reserved`
- `sold`
- `maxPerUser`

`orderId` is removed from ticket events after all consumers are migrated.

---

## 10. Failure Handling and Reconciliation

### 10.1 Reserve Failure Modes

If Redis reserve succeeds but Mongo persistence fails:

1. attempt immediate Redis compensation using the same quantity
2. return `INTERNAL` to caller
3. emit an error metric and structured log with `reservationId`, `ticketId`, `userId`

Never return success before durable reservation persistence succeeds.

### 10.2 Reconciliation Job

Run a periodic job in `ticket-service`:

1. scan all active reservations
2. recompute per-ticket `reserved`
3. compare with ticket document counters
4. compare with Redis availability and per-user reserved counts
5. correct Redis drift to match Mongo
6. alert on durable drift rather than silently rewriting Mongo

### 10.3 Reservation Expiry

Expired reservations are released by a background worker if an order was never created or if compensation failed.

This worker:

1. finds `status=RESERVED` and `expiresAt < now`
2. transitions reservation to `EXPIRED`
3. applies the release Lua script idempotently
4. decrements Mongo `reserved`

---

## 11. API and Validation Notes

- public REST still flows through Kong
- `order-service` derives user identity from trusted headers, not request body
- `quantity < 1` is `400`
- `quantity > maxPerUser` is `422`
- sold-out / quota conflict is `409`
- all service errors use the canonical error envelope

---

## 12. Implementation Plan

### Phase 1: Proto

1. add new write RPCs and reservation fields
2. regenerate Go and Java stubs

### Phase 2: ticket-service schema and repository

1. extend `Ticket`
2. add `TicketReservation`
3. add repository methods:
   - `ReserveQuota`
   - `ReleaseReservation`
   - `FinalizeReservation`
   - `FindReservationByID`

### Phase 3: Redis quota manager

1. implement cluster-safe Lua scripts
2. support reserve / release / finalize
3. expose metrics for reserve conflicts and drift corrections

### Phase 4: gRPC server

1. implement new RPCs
2. keep `ValidateTicketAvailability` temporarily
3. compute deprecated availability as `quota - reserved - sold > 0`

### Phase 5: order-service

1. add `quantity` and `reservationId` to order model
2. update create-order orchestration
3. add compensation call on transaction failure
4. publish updated outbox events

### Phase 6: Kafka consumers

1. `orders.order.cancelled` -> `ReleaseReservation`
2. `orders.order.completed` -> `FinalizeReservation`
3. make handlers idempotent by reservation state

### Phase 7: Client

1. show remaining count
2. support quantity input
3. handle `409` sold-out and `422` purchase-limit errors

---

## 13. Breaking Changes and Rollout

### Additive First

Deploy in this order:

1. deploy proto changes and new ticket-service code that supports both old and new reads
2. backfill quota fields and reservation collection
3. deploy order-service using `ReserveQuota`
4. enable new Kafka consumers for release/finalize
5. remove old `orderId` ticket reservation logic after traffic is drained

### Backward Compatibility

- existing clients omitting `quantity` get default `1`
- deprecated `ValidateTicketAvailability` remains during migration
- old tickets behave as `quota=1`

---

## 14. QA and Verification Strategy

### Unit

- reserve succeeds when quota and per-user limit allow
- reserve fails when sold out
- reserve fails when per-user limit exceeded
- release is idempotent
- finalize is idempotent
- deprecated availability includes `sold`

### Integration

- 500 concurrent reservations against quota 100 -> exactly 100 succeed
- duplicate `orders.order.cancelled` does not over-release inventory
- duplicate `orders.order.completed` does not double-sell inventory
- transaction failure after reserve triggers compensation
- Redis restart followed by reconciliation restores accurate cache state

### Contract

- order-service and ticket-service agree on new proto fields
- Kafka event payloads include `reservationId` and `quantity`

### Load

- 100K+ reserve attempts on hot ticket stay within target latency budget
- no overselling under load
- no per-user limit bypass under concurrency

---

## 15. Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Overselling under concurrency | Critical | Redis Lua + durable reservation row + Mongo reconciliation |
| Duplicate cancel/complete event | Critical | idempotent reservation state machine keyed by `reservationId` |
| Compensation failure after order TX failure | High | synchronous release attempt + expiry worker + alerting |
| Redis data loss | Medium | Redis rebuilt from Mongo counters and active reservations |
| Purchase limit bypass | High | atomic per-user check inside reserve Lua path |
| Money precision drift | High | move purchase contracts to decimal string |

---

## 16. Final Recommendation

This revised design is a better fit for production-grade quota purchasing than the original counter-only draft.

The important architectural rule is:

**inventory changes must be keyed by a durable reservation identity, not by counters alone.**

That keeps the fast path fast while making the system safe under retries, duplicates, and partial failure.
