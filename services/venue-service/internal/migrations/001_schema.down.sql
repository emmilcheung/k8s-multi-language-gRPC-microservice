-- Migration 001 rollback: drop all venue-service tables in reverse dependency order.

DROP TABLE IF EXISTS seat_reservation_items;
DROP TABLE IF EXISTS seat_reservations;
DROP TABLE IF EXISTS seats;
DROP TABLE IF EXISTS sections;
DROP TABLE IF EXISTS price_tiers;
DROP TABLE IF EXISTS seating_plans;
DROP TABLE IF EXISTS venue_sections;
DROP TABLE IF EXISTS venues;
