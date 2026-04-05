-- Migration 002: Move seat hold TTL from plan template to organizer-level config
--
-- Changes:
-- - Add organizer_settings table with hold_ttl_sec (system config per organizer)
-- - Remove hold_ttl_sec column from seating_plans (structural not operational)

CREATE TABLE IF NOT EXISTS organizer_settings (
    organizer_id UUID        PRIMARY KEY,
    hold_ttl_sec INTEGER     NOT NULL DEFAULT 600 CHECK (hold_ttl_sec > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drop the hold_ttl_sec column from seating_plans.
-- Future: will be read from env var or organizer_settings.hold_ttl_sec.
ALTER TABLE seating_plans DROP COLUMN hold_ttl_sec;
