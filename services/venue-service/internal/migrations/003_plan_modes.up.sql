-- Migration 003: Add assignment_mode and pricing_mode to seating_plans
--
-- These columns enable sellers to define:
--   assignment_mode: How seats are assigned to buyers
--     - 'manual': Buyers manually pick seats
--     - 'auto': System auto-assigns available seats
--
--   pricing_mode: How seats are priced
--     - 'single': All seats cost the same (ticket base price)
--     - 'section': Price varies by section (via section.price_tier_id)
--     - 'seat': Price varies by individual seat (future: seat.price_tier_id)

ALTER TABLE seating_plans
  ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (assignment_mode IN ('manual', 'auto')),
  ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'single'
    CHECK (pricing_mode IN ('single', 'section', 'seat'));
