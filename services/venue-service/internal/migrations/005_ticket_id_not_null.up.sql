-- Migration 005: Retire plans without tickets (soft)
--
-- Phase 4 cleanup: All plans must now have a ticket_id at the app layer.
-- Legacy plans without a ticket can no longer participate in the product flow,
-- so deactivate them.  We intentionally keep ticket_id nullable at the DB level
-- to avoid cascading DELETEs that would destroy sections, seats, and reservation
-- history.  The NOT NULL invariant is enforced by the application (plan_handler
-- rejects creates without ticketId).

-- Mark any orphaned plans (without ticket_id and currently active) as inactive
UPDATE seating_plans
SET status = 'inactive'
WHERE ticket_id IS NULL AND status = 'active';
