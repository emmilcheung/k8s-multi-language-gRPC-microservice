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

## Consumer Rules

- Consumers must be **idempotent** — the same message may be delivered more than once.
- Use consumer group IDs named after the service: `order-service`, `notification-service`.
- Commit offsets **after** successful processing, not before.
- On processing failure: retry with back-off (exponential, max 3 attempts), then route to a **Dead Letter Topic** (`<original-topic>.dlq`). Never silently discard a message.
- Do not mix business logic with offset management — separate the Kafka polling loop from the handler function.
