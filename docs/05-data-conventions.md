# Data & Database Conventions

## Database-per-Service

Each service gets its own isolated datastore — no cross-service DB access.

Choose the right database for the access pattern:

| Store | Use when |
|---|---|
| **PostgreSQL** | Relational data, ACID transactions, complex joins, financial records |
| **MongoDB** | Document-oriented data, flexible schema, high write throughput, nested structures |
| **Redis** | Cache, session store, rate-limit counters, distributed locks, pub/sub |
| **Elasticsearch** | Full-text search, log aggregation |

## PostgreSQL Conventions

- Use migrations (Flyway / Liquibase / TypeORM migrations / golang-migrate) — never alter schema manually.
- Migration files are append-only and immutable once merged to main.
- Always name constraints explicitly: `fk_orders_user_id`, `uq_users_email`, `ck_price_positive`.
- Use `UUID` as primary keys (v4), not auto-increment integers.
- `created_at` and `updated_at` timestamps on every table, maintained by DB triggers or ORM hooks.
- Use row-level locking (`SELECT ... FOR UPDATE`) for optimistic or pessimistic concurrency — never rely on application-level locking across network calls.
- Never use `SELECT *` — always name columns explicitly.
- Index every foreign key and every column used in `WHERE`, `ORDER BY`, or `JOIN` clauses.
- Sensitive columns (PII, secrets): encrypt at rest at the application layer; do not rely solely on disk encryption.

## MongoDB Conventions

- Define and enforce a JSON Schema validator on every collection.
- Always include `createdAt`, `updatedAt` fields (mongoose `timestamps` option or equivalent).
- Use UUIDs (`string`) as `_id` — do not rely on ObjectId across services (not portable).
- Index fields used in query filters and sorts; profile with `explain()` before deploying to production.
- Use sessions and multi-document transactions only when atomicity is truly required — prefer document embedding to avoid the need.
- Apply optimistic concurrency control (OCC) with a `__v` / `version` field for documents updated concurrently.

## Redis Conventions

- Cache keys: `<service>:<entity>:<id>` e.g. `order-service:order:uuid-123`.
- Always set a TTL — never persist a key without expiry unless it is an explicit, intentional data store.
- Use Redis Cluster or ElastiCache cluster mode in production — do not use single-node Redis for production data.
- Distributed locks: use Redlock algorithm with a minimum of 3 nodes.
- Never store sensitive data (passwords, raw tokens) in Redis.
