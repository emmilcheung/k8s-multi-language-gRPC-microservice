-- Migration 011 down: remove price_tier_id from sections.
ALTER TABLE sections DROP COLUMN IF EXISTS price_tier_id;
