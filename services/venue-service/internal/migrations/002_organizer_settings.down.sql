-- Rollback Migration 002: restore seat hold TTL to seating_plans

ALTER TABLE seating_plans
ADD COLUMN hold_ttl_sec INTEGER NOT NULL DEFAULT 600 CHECK (hold_ttl_sec > 0);

DROP TABLE IF EXISTS organizer_settings;
