-- Migration 004: price_tiers table
-- A price tier defines a named price level within a seating plan.
-- price is stored as NUMERIC to avoid floating-point rounding errors.

CREATE TABLE IF NOT EXISTS price_tiers (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id    UUID         NOT NULL REFERENCES seating_plans (id) ON DELETE CASCADE,
    name       TEXT         NOT NULL,
    price      NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_tiers_plan_id ON price_tiers (plan_id);
