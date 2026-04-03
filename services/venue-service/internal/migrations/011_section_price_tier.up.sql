-- Migration 011: add optional price_tier_id to sections.
-- Each section can be assigned a single price tier so all seats in the section
-- share the same price. NULL means "use the ticket's default price".

ALTER TABLE sections
  ADD COLUMN IF NOT EXISTS price_tier_id UUID NULL
    REFERENCES price_tiers (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sections_price_tier_id
  ON sections (price_tier_id)
  WHERE price_tier_id IS NOT NULL;
