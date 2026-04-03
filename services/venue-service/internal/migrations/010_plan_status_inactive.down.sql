-- Migration 010 down: revert "inactive" → "closed"
UPDATE seating_plans SET status = 'closed' WHERE status = 'inactive';

ALTER TABLE seating_plans
  DROP CONSTRAINT IF EXISTS seating_plans_status_check;

ALTER TABLE seating_plans
  ADD CONSTRAINT seating_plans_status_check
    CHECK (status IN ('draft', 'active', 'closed'));
