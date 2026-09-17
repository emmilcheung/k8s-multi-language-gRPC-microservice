# Asynchronous Messaging (Kafka)

## When to Use Kafka vs gRPC

| Use Kafka | Use gRPC |
|---|---|
| Event fan-out to multiple consumers | One caller needs an immediate response |
| Cross-domain eventual consistency | Strong consistency within a request scope |
| Audit log / event sourcing | Real-time bi-directional streaming between two services |
| Decoupling producer from consumer lifecycle | Internal lookups and aggregations |

## Topic Naming Convention

```
<domain>.<entity>.<event-verb>

Examples:
orders.order.created
orders.order.cancelled
payments.payment.captured
inventory.stock.depleted
```

## Event Schema

Follow **CloudEvents v1.0** spec. Every event envelope must contain:

```json
{
  "specversion": "1.0",
  "type": "orders.order.created",
  "source": "order-service",
  "id": "<uuid-v4>",
  "time": "<ISO-8601>",
  "datacontenttype": "application/json",
  "data": { /* domain payload */ }
}
```

Validate against the schema registry before producing.

## Producer Rules

- Events are **immutable facts** — never mutate or delete a published event.
- Use **transactional outbox pattern** when producing from a database transaction: write to an `outbox` table in the same DB transaction as the business update; a relay process publishes to Kafka. Never produce to Kafka directly inside a DB transaction.
- Set `acks=all` and `enable.idempotence=true` on every producer.
- Partition key = primary entity ID (e.g. `orderId`) to preserve per-entity ordering.

## Outbox Relay Claim Contract

Every relay runs on every replica. Without a claim step, N replicas read the same unpublished rows and publish each event N times. **A relay must claim a row before publishing it** — reading unpublished rows and publishing them is not an acceptable implementation at any replica count, including one, because the replica count is a deployment decision that changes without touching the relay.

One contract, two mechanisms, chosen by the store:

**SQL stores (Postgres).** Claim and publish inside a single transaction:

```sql
SELECT ... FROM outbox
WHERE published = false
ORDER BY created_at ASC
LIMIT :batch_size
FOR UPDATE SKIP LOCKED
```

`SKIP LOCKED` is what makes concurrent relays claim *disjoint* rows instead of queueing behind each other. Mark the rows published **on that same transaction**. Claiming on one connection and marking on another is a defect, not a style choice: the claim's row locks are held by the first connection, so the second blocks on it while the first waits for the second to return — a deadlock Postgres cannot detect, because it only sees one session waiting on another's lock. It resolves at `lock_timeout`, not by aborting.

**Document stores (Mongo).** Claim by lease: `findOneAndUpdate` a row whose lease is absent or expired, setting a `claimToken` and a `leaseUntil`. The lease expiry *is* the recovery path — a relay that crashes mid-publish releases its rows when the lease lapses, with no reaper process. `SKIP LOCKED`'s equivalent is the atomicity of `findOneAndUpdate` itself.

Both mechanisms give at-least-once delivery, never exactly-once. Duplicates remain possible whenever a publish succeeds and the mark-published does not, so **consumers must dedupe on the envelope `id`** (Event Schema, above) to satisfy the idempotency requirement in Consumer Rules. The claim eliminates the *systematic* N× duplication of un-claimed relays; it does not eliminate duplicates.

**Commit per batch, not per message.** Marking each message published in its own transaction is structurally incompatible with holding a `SKIP LOCKED` claim open: an inner `REQUIRES_NEW` transaction updating a row the outer transaction has locked blocks on the outer, while the outer synchronously waits for that inner call to return. Per-message durability therefore requires abandoning `SKIP LOCKED` for claim-by-`UPDATE`, which costs a lease column, a migration and a stuck-claim reaper. The tradeoff accepted here is that one failing row can affect the rest of its batch; make the batch size configurable by environment variable so it can be tuned down under load.

**Keep the claim short.** The claim transaction holds row locks for as long as it is open, including across every broker round-trip in the batch. Do not do unbounded work inside it, and do not size batches so large that a slow broker holds locks for seconds.

**Testing a relay claim is where this goes wrong most often.** A concurrency test must drive the real relay, not re-implement its query — a test that issues its own `FOR UPDATE SKIP LOCKED` verifies PostgreSQL, and stays green when the claim is deleted from the service. The test must be shown to fail with the claim removed before it is trusted.

Reference implementations: `order-service` (JPA native query), `payment-service` (Drizzle `.for('update', { skipLocked: true })`), `attendance-service` (pgx), `ticket-service` (Mongo lease).

## Consumer Rules

- Consumers must be **idempotent** — the same message may be delivered more than once.
- Use consumer group IDs named after the service: `order-service`, `notification-service`.
- Commit offsets **after** successful processing, not before.
- On processing failure: retry with back-off (exponential, max 3 attempts), then route to a **Dead Letter Topic** (`<original-topic>.dlq`). Never silently discard a message.
- Do not mix business logic with offset management — separate the Kafka polling loop from the handler function.
