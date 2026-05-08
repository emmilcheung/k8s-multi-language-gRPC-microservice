-- Migration 003 rollback: drop issuance_event_published_at column
ALTER TABLE admission_credentials DROP COLUMN IF EXISTS issuance_event_published_at;
