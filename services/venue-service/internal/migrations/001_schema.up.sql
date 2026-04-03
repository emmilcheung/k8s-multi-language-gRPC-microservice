-- Migration 001: full venue-service schema (consolidated)
--
-- Tables in dependency order:
--   venues → venue_sections
--   venues → seating_plans → price_tiers
--                          → sections (refs price_tiers)
--                          → seats (refs sections, price_tiers nullable)
--                          → seat_reservations → seat_reservation_items

-- ── venues ────────────────────────────────────────────────────────────────────

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

-- ── venue_sections ────────────────────────────────────────────────────────────
-- Reusable layout template per venue. Cloned into plan-scoped sections rows
-- when a new seating plan is created, giving each event independent inventory.

CREATE TABLE IF NOT EXISTS venue_sections (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id      UUID        NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    type          TEXT        NOT NULL DEFAULT 'seated'
                              CHECK (type IN ('seated', 'ga')),
    row_count     INTEGER     NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    column_count  INTEGER     NOT NULL DEFAULT 0 CHECK (column_count >= 0),
    position_json JSONB       NOT NULL DEFAULT '{}',
    display_order INTEGER     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_sections_venue_id ON venue_sections (venue_id);

-- ── seating_plans ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS seating_plans (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id            UUID        NOT NULL REFERENCES venues (id),
    ticket_id           UUID        NULL,
    organizer_id        UUID        NOT NULL,
    name                TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft', 'active', 'inactive')),
    hold_ttl_sec        INTEGER     NOT NULL DEFAULT 600 CHECK (hold_ttl_sec > 0),
    max_seats_per_order INTEGER     NOT NULL DEFAULT 10 CHECK (max_seats_per_order > 0),
    layout_json         JSONB       NOT NULL DEFAULT '{}',
    version             INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seating_plans_venue_id     ON seating_plans (venue_id);
CREATE INDEX IF NOT EXISTS idx_seating_plans_ticket_id    ON seating_plans (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seating_plans_organizer_id ON seating_plans (organizer_id);
CREATE INDEX IF NOT EXISTS idx_seating_plans_status       ON seating_plans (status);

-- ── price_tiers ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS price_tiers (
    id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id    UUID          NOT NULL REFERENCES seating_plans (id) ON DELETE CASCADE,
    name       TEXT          NOT NULL,
    price      NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    created_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_tiers_plan_id ON price_tiers (plan_id);

-- ── sections ──────────────────────────────────────────────────────────────────
-- Event-scoped seat groups, cloned from venue_sections at plan creation.
-- price_tier_id is nullable: NULL means fall back to the ticket's base price.

CREATE TABLE IF NOT EXISTS sections (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id       UUID        NOT NULL REFERENCES seating_plans (id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    type          TEXT        NOT NULL DEFAULT 'seated' CHECK (type IN ('seated', 'ga')),
    row_count     INTEGER     NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    column_count  INTEGER     NOT NULL DEFAULT 0 CHECK (column_count >= 0),
    price_tier_id UUID        NULL REFERENCES price_tiers (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sections_plan_id      ON sections (plan_id);
CREATE INDEX IF NOT EXISTS idx_sections_price_tier_id ON sections (price_tier_id) WHERE price_tier_id IS NOT NULL;

-- ── seats ─────────────────────────────────────────────────────────────────────
-- One row per bookable seat. price_tier_id nullable: NULL = ticket base price.

CREATE TABLE IF NOT EXISTS seats (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id    UUID          NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
    plan_id       UUID          NOT NULL REFERENCES seating_plans (id) ON DELETE CASCADE,
    price_tier_id UUID          NULL REFERENCES price_tiers (id),
    seat_label    TEXT          NOT NULL,
    row_label     TEXT          NOT NULL DEFAULT '',
    column_number INTEGER       NOT NULL DEFAULT 0,
    status        TEXT          NOT NULL DEFAULT 'AVAILABLE'
                                CHECK (status IN ('AVAILABLE', 'HELD', 'RESERVED', 'SOLD', 'BLOCKED')),
    held_by       UUID          NULL,
    held_until    TIMESTAMPTZ   NULL,
    attributes    JSONB         NOT NULL DEFAULT '{}',
    version       INTEGER       NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seats_section_id     ON seats (section_id);
CREATE INDEX IF NOT EXISTS idx_seats_section_status ON seats (section_id, status) WHERE status = 'AVAILABLE';
CREATE INDEX IF NOT EXISTS idx_seats_held_until     ON seats (held_until) WHERE held_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seats_plan_id        ON seats (plan_id);

-- ── seat_reservations ─────────────────────────────────────────────────────────
-- Durable reservation ledger; source of truth for idempotent release/finalize.

CREATE TABLE IF NOT EXISTS seat_reservations (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id    UUID        NOT NULL REFERENCES seating_plans (id),
    ticket_id  UUID        NOT NULL,
    order_id   UUID        NULL,
    user_id    UUID        NOT NULL,
    section_id UUID        NULL REFERENCES sections (id),
    status     TEXT        NOT NULL DEFAULT 'RESERVED'
               CHECK (status IN ('RESERVED', 'RELEASED', 'SOLD', 'EXPIRED')),
    expires_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seat_reservations_order_id    ON seat_reservations (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seat_reservations_user_id     ON seat_reservations (user_id);
CREATE INDEX IF NOT EXISTS idx_seat_reservations_plan_status ON seat_reservations (plan_id, status);
CREATE INDEX IF NOT EXISTS idx_seat_reservations_expires_at  ON seat_reservations (expires_at) WHERE expires_at IS NOT NULL;

-- ── seat_reservation_items ────────────────────────────────────────────────────
-- One row per seat within a reservation. Price is snapshotted at reservation
-- time so tier changes do not retroactively affect existing orders.

CREATE TABLE IF NOT EXISTS seat_reservation_items (
    reservation_id UUID          NOT NULL REFERENCES seat_reservations (id) ON DELETE CASCADE,
    seat_id        UUID          NOT NULL REFERENCES seats (id),
    section_id     UUID          NOT NULL REFERENCES sections (id),
    price          NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    seat_label     TEXT          NOT NULL,
    PRIMARY KEY (reservation_id, seat_id)
);

CREATE INDEX IF NOT EXISTS idx_reservation_items_reservation_id ON seat_reservation_items (reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_items_seat_id        ON seat_reservation_items (seat_id);
