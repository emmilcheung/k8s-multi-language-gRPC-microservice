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

## Connection Budget

A connection pool is a shared, finite resource. Every service states its pool size
explicitly — never inherit a driver default, because those defaults move with the
runtime (pgx defaults to `max(4, GOMAXPROCS)`, which changes when a CPU limit
changes; the Mongo driver defaults to 100 *per client*; HikariCP defaults to 10).
A pool that is sized implicitly is a pool nobody has budgeted for.

**The rule:** for each datastore, Σ(pool size × `autoscaling.maxReplicas`) over
every service that connects to it must stay at or below **80% of the store's
connection ceiling**. The remaining 20% is headroom for migrations, `psql`
sessions, monitoring scrapes, and the brief overlap during a rolling update.

No chart overrides `max_connections`, so the PostgreSQL default of **100** applies
— a budget of **80** per instance. Because the platform is database-per-service,
each budget is checked against a single instance, not fleet-wide.

| Service | Store | Pool (per pod) | maxReplicas | Peak | Budget | Where the pool is set |
|---|---|---|---|---|---|---|
| auth-service | PostgreSQL | 12 | 6 | 72 | 80 | `DB_POOL_MAX` (chart `env`) |
| user-service | PostgreSQL | 12 | 6 | 72 | 80 | `DB_POOL_MAX` (Secret — see below) |
| payment-service | PostgreSQL | 12 | 6 | 72 | 80 | `DB_POOL_MAX` (chart `env`) |
| venue-service | PostgreSQL | 10 | 6 | 60 | 80 | `DB_POOL_MAX` (chart `env`) |
| attendance-service | PostgreSQL | 10 | 4 | 40 | 80 | `DB_POOL_MAX` (chart `env`) |
| order-service | PostgreSQL | 8 | 8 | 64 | 80 | `DB_POOL_MAX` → `spring.datasource.hikari.maximum-pool-size` |
| ticket-service | MongoDB | 50 | 6 | 300 | see below | `MONGO_MAX_POOL_SIZE` (chart `env`) |

MongoDB's analogue of `max_connections` is `net.maxIncomingConnections`. The
Bitnami chart leaves `configuration` empty, so no `mongod.conf` is supplied and
mongod's own default of **65536** applies — but mongod additionally caps incoming
connections at **80% of the process's soft `RLIMIT_NOFILE`**, and neither the
chart nor our values set a ulimit. So the *declared* ceiling is never the binding
one; the binding one is memory.

The driver's `maxPoolSize` is **per server in the topology, not per client**: the
Go driver keeps one pool per member and a separate heartbeat connection per
member outside the pool. With `readpref.Primary()` almost every operation lands
on the primary, so the primary is what has to absorb 50 × 6 = **300**.

That does not fit the chart as we deploy it. `mongodb` is `enabled: false` in
both `values-staging.yaml` and `values-prod.yaml` — the chart only ever runs
locally, at `replicaCount: 1` with a **512Mi** memory limit. MongoDB budgets
roughly **1MB of memory per connection**, and the WiredTiger cache has a 256MB
floor on a container that small, so ~300 connections would OOMKill the pod long
before any connection limit rejected them. The practical ceiling for this chart
is on the order of **200** connections, and local runs one ticket-service pod —
50 — so it is never approached. **Do not read the local chart as a rehearsal for
300.**

The 300 has to be checked against the managed cluster that serves staging and
prod, whose ceiling is a published per-tier limit rather than a config key. By
the same 80% rule the tier must allow at least **375** connections; Atlas M10 and
up are documented at 1,500, which clears it. Confirm this against the tier
actually purchased — the tier is still an open owner decision, so treat 300 as
provisional until it is signed off.

**When you change either number, re-do the arithmetic.** Raising
`autoscaling.maxReplicas` without lowering the pool silently overruns the budget;
the symptom is `FATAL: sorry, too many clients already` under load, and the pods
that fail are the ones that scaled up to handle the load. If a service genuinely
needs more, raise `max_connections` on that instance first (and size the
instance's memory for it) or put PgBouncer in front in transaction-pooling mode.

## Redis Conventions

- Cache keys: `<service>:<entity>:<id>` e.g. `order-service:order:uuid-123`.
- Always set a TTL — never persist a key without expiry unless it is an explicit, intentional data store.
- Use Redis Cluster or ElastiCache cluster mode in production — do not use single-node Redis for production data.
- Distributed locks: use Redlock algorithm with a minimum of 3 nodes.
- Never store sensitive data (passwords, raw tokens) in Redis.
