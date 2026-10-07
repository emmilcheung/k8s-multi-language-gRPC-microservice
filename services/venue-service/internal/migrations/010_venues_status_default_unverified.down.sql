-- Rollback Migration 010
ALTER TABLE venues ALTER COLUMN status SET DEFAULT 'VERIFIED';
