-- Migration 006: index the per-buyer seat count
--
-- When SEATED_CAP_ENFORCED is on, every hold and reserve counts the buyer's
-- live holds on the plan. Without this index that count reads every seat of
-- the plan through idx_seats_plan_id, on the hottest path of an onsale.
--
-- CONCURRENTLY keeps the seats table writable while the index builds; it must
-- be the only statement in the file so golang-migrate runs it outside a
-- transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_seats_held_by_plan ON seats (held_by, plan_id) WHERE status = 'HELD';
