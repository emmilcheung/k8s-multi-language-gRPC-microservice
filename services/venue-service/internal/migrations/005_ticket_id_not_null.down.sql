-- Down migration for 005: Revert ticket_id to nullable
--
-- Restores the schema to allow nullable ticket_id for downgrade scenarios.

ALTER TABLE seating_plans
ALTER COLUMN ticket_id DROP NOT NULL;
