-- Migration 002 rollback: drop issuance_key column
DROP INDEX IF EXISTS idx_admission_credentials_issuance_key;
ALTER TABLE admission_credentials DROP COLUMN IF EXISTS issuance_key;
