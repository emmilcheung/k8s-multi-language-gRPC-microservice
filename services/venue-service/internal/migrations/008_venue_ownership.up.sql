-- Migration 008: venue verification status and owning account
--
-- status: every venue that exists today is in use, so it starts VERIFIED. The
-- default stays VERIFIED until venue creation itself starts writing
-- UNVERIFIED; changing it then is a one-line follow-up.
-- created_by_account_id: nullable until the ownership backfill has run.
-- organizer_id keeps meaning "created by" and is not touched.
ALTER TABLE venues
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'VERIFIED'
        CHECK (status IN ('UNVERIFIED', 'VERIFIED')),
    ADD COLUMN IF NOT EXISTS created_by_account_id UUID NULL;
