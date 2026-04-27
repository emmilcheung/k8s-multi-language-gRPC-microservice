-- Migration 005: Make ticket_id NOT NULL and retire plans without tickets
--
-- Phase 4 cleanup: All plans must now have a ticket_id. Plans created during
-- ticket-first rollout phases will have ticket_id populated at creation.
-- Legacy plans without a ticket can no longer participate in the product flow,
-- so retire them before enforcing NOT NULL.

-- Mark any orphaned plans (without ticket_id and currently active) as inactive
UPDATE seating_plans
SET status = 'inactive'
WHERE ticket_id IS NULL AND status = 'active';

-- Remove legacy unattached plans so the schema can enforce the new invariant.
DELETE FROM seating_plans
WHERE ticket_id IS NULL;

-- Alter column to NOT NULL
ALTER TABLE seating_plans
ALTER COLUMN ticket_id SET NOT NULL;
