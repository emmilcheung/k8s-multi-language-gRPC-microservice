-- Migration 003: sections table
-- A section is a named group of seats (or GA capacity) within a seating plan.

CREATE TABLE IF NOT EXISTS sections (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id      UUID        NOT NULL REFERENCES seating_plans (id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    type         TEXT        NOT NULL DEFAULT 'seated' CHECK (type IN ('seated', 'ga')),
    row_count    INTEGER     NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    column_count INTEGER     NOT NULL DEFAULT 0 CHECK (column_count >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sections_plan_id ON sections (plan_id);
