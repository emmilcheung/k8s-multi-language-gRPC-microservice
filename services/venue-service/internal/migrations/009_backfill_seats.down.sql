-- 009_backfill_seats.down.sql
-- Remove any seats that were auto-backfilled by 009_backfill_seats.up.sql.
-- Deletes ALL seats — use with care in non-local environments.
DELETE FROM seats;
