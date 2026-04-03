-- Migration 012: venue_sections — reusable seating layout template per venue.
--
-- A venue section defines the *physical* seating structure of a building (rows,
-- columns, capacity).  It is a TEMPLATE: it carries no inventory state (holds,
-- reservations, etc.).
--
-- When a seating plan is created for a specific event (ticket), the venue
-- sections are cloned into plan-scoped `sections` rows and their seat rows are
-- generated, giving each event its own fully independent seat inventory.

CREATE TABLE IF NOT EXISTS venue_sections (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id      UUID        NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    type          TEXT        NOT NULL DEFAULT 'seated'
                              CHECK (type IN ('seated', 'ga')),
    row_count     INTEGER     NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    column_count  INTEGER     NOT NULL DEFAULT 0 CHECK (column_count >= 0),
    -- position_json stores the canvas (x,y) placement for the seating map editor.
    position_json JSONB       NOT NULL DEFAULT '{}',
    display_order INTEGER     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_sections_venue_id
    ON venue_sections (venue_id);
