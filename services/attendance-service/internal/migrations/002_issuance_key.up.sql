-- Migration 002: add issuance_key for idempotent credential issuance
--
-- issuance_key is a deterministic, per-admission-unit key that prevents duplicate
-- credentials from being issued if the same orders.order.completed event is delivered
-- more than once.  The derivation rules are:
--   GA order (no seatIds):    "{orderId}:unit:{index}"  (index = 0..quantity-1)
--   Seated order (seatIds):   "{orderId}:seat:{seatId}"
--
-- The unique constraint is the enforcement point; the application also checks before
-- inserting to produce a clear idempotency log entry rather than relying solely on
-- the error path.

ALTER TABLE admission_credentials
    ADD COLUMN IF NOT EXISTS issuance_key TEXT;

-- Backfill existing rows so NOT NULL can be set cleanly.
UPDATE admission_credentials
    SET issuance_key = id::text
    WHERE issuance_key IS NULL;

ALTER TABLE admission_credentials
    ALTER COLUMN issuance_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admission_credentials_issuance_key
    ON admission_credentials (issuance_key);
