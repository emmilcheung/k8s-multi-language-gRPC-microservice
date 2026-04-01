-- Migration 001: venues table
-- venue-service owns this table exclusively.

CREATE TABLE IF NOT EXISTS venues (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID        NOT NULL,
    name         TEXT        NOT NULL,
    capacity     INTEGER     NOT NULL DEFAULT 0 CHECK (capacity >= 0),
    timezone     TEXT        NOT NULL DEFAULT 'UTC',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venues_organizer_id ON venues (organizer_id);
