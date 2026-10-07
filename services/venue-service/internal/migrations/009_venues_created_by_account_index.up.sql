-- Migration 009: index venues by owning account
--
-- CONCURRENTLY keeps venues writable while the index builds; it must be the
-- only statement in the file so golang-migrate runs it outside a transaction.
-- If it is interrupted the index is left INVALID: drop it and re-run, as for
-- migration 006.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venues_created_by_account_id ON venues (created_by_account_id) WHERE created_by_account_id IS NOT NULL;
