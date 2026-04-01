-- Migration 005: seats table
-- One row per bookable seat inside a section.
-- status is the hot-path state for seat inventory; the reservation ledger is the durable source of truth.

CREATE TABLE IF NOT EXISTS seats (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id    UUID        NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
    plan_id       UUID        NOT NULL REFERENCES seating_plans (id) ON DELETE CASCADE,
    price_tier_id UUID        NOT NULL REFERENCES price_tiers (id),
    seat_label    TEXT        NOT NULL,
    row_label     TEXT        NOT NULL DEFAULT '',
    column_number INTEGER     NOT NULL DEFAULT 0,
    status        TEXT        NOT NULL DEFAULT 'AVAILABLE'
                              CHECK (status IN ('AVAILABLE', 'HELD', 'RESERVED', 'SOLD', 'BLOCKED')),
    held_by       UUID        NULL,
    held_until    TIMESTAMPTZ NULL,
    attributes    JSONB       NOT NULL DEFAULT '{}',
    version       INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary lookup: all seats in a section (seat-map rendering)
CREATE INDEX IF NOT EXISTS idx_seats_section_id ON seats (section_id);

-- Available seats within a section (used by auto-assign)
CREATE INDEX IF NOT EXISTS idx_seats_section_status ON seats (section_id, status) WHERE status = 'AVAILABLE';

-- Expired hold sweep: find seats with expired holds
CREATE INDEX IF NOT EXISTS idx_seats_held_until ON seats (held_until) WHERE held_until IS NOT NULL;

-- Lookup by plan (for plan-level operations)
CREATE INDEX IF NOT EXISTS idx_seats_plan_id ON seats (plan_id);
