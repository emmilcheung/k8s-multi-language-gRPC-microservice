-- Restore NOT NULL on price_tier_id.
-- This will fail if any rows have a NULL price_tier_id; clean up first.
ALTER TABLE seats
    ALTER COLUMN price_tier_id SET NOT NULL;
