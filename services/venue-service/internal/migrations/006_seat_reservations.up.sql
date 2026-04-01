-- Migration 006: seat_reservations table
-- Durable reservation ledger. This is the source of truth for idempotent
-- release and finalize operations. order_id is nullable until the order is created.

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

-- Lookup by order (for Kafka event handlers)
CREATE INDEX IF NOT EXISTS idx_seat_reservations_order_id   ON seat_reservations (order_id) WHERE order_id IS NOT NULL;

-- Lookup by user (for per-user reservation queries)
CREATE INDEX IF NOT EXISTS idx_seat_reservations_user_id    ON seat_reservations (user_id);

-- Active reservations per plan (for availability checks)
CREATE INDEX IF NOT EXISTS idx_seat_reservations_plan_status ON seat_reservations (plan_id, status);

-- Expired reservation sweep
CREATE INDEX IF NOT EXISTS idx_seat_reservations_expires_at ON seat_reservations (expires_at) WHERE expires_at IS NOT NULL;
