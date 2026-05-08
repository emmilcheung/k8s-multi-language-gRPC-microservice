-- Migration 003: add issuance_event_published_at for durable publication state
--
-- This column allows the issuance service to distinguish between:
--   (a) a credential that was fully processed (DB insert + event published), and
--   (b) a credential that was inserted but whose event publish failed.
--
-- NULL  → credential exists but attendance.qr.issued has NOT been published yet.
--         The issuance consumer must publish and then set this column.
-- non-NULL → credential is fully processed; duplicate deliveries must be silently
--            skipped without re-publishing.
--
-- Backfill: existing rows are treated as already-published so that the migration
-- is safe on pre-existing production data (conservative default).

ALTER TABLE admission_credentials
    ADD COLUMN IF NOT EXISTS issuance_event_published_at TIMESTAMPTZ NULL;

-- Backfill existing rows as already-published to avoid spurious re-publishes on
-- the first deployment that includes this migration.
UPDATE admission_credentials
    SET issuance_event_published_at = now()
    WHERE issuance_event_published_at IS NULL;
