-- Migration 002: seating_plans table
-- ticket_id is nullable during draft creation; required before activation (enforced at app layer).

CREATE TABLE IF NOT EXISTS seating_plans (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id            UUID        NOT NULL REFERENCES venues (id),
    ticket_id           UUID        NULL,
    organizer_id        UUID        NOT NULL,
    name                TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
    hold_ttl_sec        INTEGER     NOT NULL DEFAULT 600 CHECK (hold_ttl_sec > 0),
    max_seats_per_order INTEGER     NOT NULL DEFAULT 10 CHECK (max_seats_per_order > 0),
    version             INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seating_plans_venue_id      ON seating_plans (venue_id);
CREATE INDEX IF NOT EXISTS idx_seating_plans_ticket_id     ON seating_plans (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seating_plans_organizer_id  ON seating_plans (organizer_id);
CREATE INDEX IF NOT EXISTS idx_seating_plans_status        ON seating_plans (status);
