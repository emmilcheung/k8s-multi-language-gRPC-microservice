-- Migration 008: add outbox.published_at
--
-- MarkPublishedTx (internal/repository/postgres/credential_repo.go) has always
-- written `published_at` when the relay marks a row published, but migration 004
-- never created the column, so the statement fails against the real schema. The
-- gap went unnoticed because credential_repo_test.go creates its own outbox table
-- (with published_at) via CREATE TABLE IF NOT EXISTS.
--
-- Additive and idempotent — safe to apply to an existing outbox table.
ALTER TABLE outbox
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL;
