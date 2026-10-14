-- Rollback Migration 009
DROP INDEX CONCURRENTLY IF EXISTS idx_venues_created_by_account_id;
