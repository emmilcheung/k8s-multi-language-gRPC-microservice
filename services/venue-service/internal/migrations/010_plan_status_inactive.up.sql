-- Migration 010: rename plan status "closed" → "inactive" for clarity.
-- The previous constraint used "closed" but the client and API docs use "inactive".
-- Since no deactivate endpoint existed, there are no rows with status='closed' in production.

ALTER TABLE seating_plans
  DROP CONSTRAINT IF EXISTS seating_plans_status_check;

ALTER TABLE seating_plans
  ADD CONSTRAINT seating_plans_status_check
    CHECK (status IN ('draft', 'active', 'inactive'));
