-- Rollback Migration 008
ALTER TABLE venues
    DROP COLUMN IF EXISTS created_by_account_id,
    DROP COLUMN IF EXISTS status;
