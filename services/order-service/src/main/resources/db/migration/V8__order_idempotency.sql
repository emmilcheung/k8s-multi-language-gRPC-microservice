-- V8__order_idempotency.sql
-- Idempotency-Key on POST /api/orders and /api/orders/seated.
--
-- request_fingerprint: sha256 (hex, 64 chars) of the canonical JSON request body,
--   stored so a retry with the same key but a different body can be told apart from a
--   true replay (422 IDEMPOTENCY_KEY_REUSED). NULL for orders created without a key.
--
-- uq_orders_reservation_id: with a key, reservation_id is derived from (user, key), so
--   the unique index is what makes two concurrent same-key requests collapse into one
--   order (the loser gets a unique violation and returns the winner without compensating).
--   Orders without a key keep a random reservation_id, so the index never conflicts.
--   idx_orders_reservation_id (V2, non-unique) is left in place; it is now redundant
--   for lookups and can be dropped in a later migration.
--
-- PRE-CHECK (must return 0 rows in EVERY environment before this runs, else the
-- CREATE UNIQUE INDEX fails and Flyway aborts):
--   SELECT reservation_id FROM orders WHERE reservation_id IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;
--
-- Plain CREATE UNIQUE INDEX (not CONCURRENTLY), as in V6/V7: Flyway runs each migration
-- in a transaction and CONCURRENTLY cannot run inside one. The build takes a SHARE lock
-- that blocks writes to `orders` for its duration; volumes are small today. When the table
-- grows, run this variant by hand outside Flyway BEFORE deploying (statement must run
-- outside a transaction) and let this migration's IF NOT EXISTS make it a no-op:
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_orders_reservation_id
--     ON orders (reservation_id) WHERE reservation_id IS NOT NULL;
-- A failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would silently
-- skip: check pg_index.indisvalid for uq_orders_reservation_id and DROP INDEX it before rerunning.

ALTER TABLE orders
    ADD COLUMN request_fingerprint VARCHAR(64) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_reservation_id
    ON orders (reservation_id) WHERE reservation_id IS NOT NULL;
