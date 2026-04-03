-- Migration 013: make seats.price_tier_id nullable.
--
-- Seats are provisioned when a seating plan is created (cloned from the venue
-- template).  Price tiers are defined AFTER plan creation and applied to
-- sections, so seats may legitimately have no price tier at provisioning time.
-- A NULL price_tier_id means "fall back to the ticket's base price".

ALTER TABLE seats
    ALTER COLUMN price_tier_id DROP NOT NULL;
