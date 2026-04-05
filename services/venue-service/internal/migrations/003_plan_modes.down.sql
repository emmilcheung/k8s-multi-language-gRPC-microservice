-- Migration 003 down: Remove assignment_mode and pricing_mode from seating_plans

ALTER TABLE seating_plans
  DROP COLUMN pricing_mode,
  DROP COLUMN assignment_mode;
