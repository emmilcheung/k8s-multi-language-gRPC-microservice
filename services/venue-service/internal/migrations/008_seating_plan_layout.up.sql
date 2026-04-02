-- 008_seating_plan_layout.up.sql
-- Adds a JSONB column to persist the 2-D canvas layout for a seating plan.
-- Stores section node positions and per-row x-offsets for staggered layouts.
ALTER TABLE seating_plans
    ADD COLUMN layout_json JSONB NOT NULL DEFAULT '{}';
