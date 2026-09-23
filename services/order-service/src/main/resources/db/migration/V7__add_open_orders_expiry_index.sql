-- SR-16. OrderExpirySweepJob looks up open orders whose expires_at has passed.
-- Only open orders belong in this index. They are a small, short-lived set,
-- while COMPLETE and CANCELLED rows pile up forever, so the index stays small
-- and the sweep never has to scan the whole table.
--
-- The WHERE clause must match the repository query's status literals exactly
-- (OrderRepository.findOverdueOpenOrderIds). Otherwise the planner can't prove
-- the query implies the predicate and falls back to a sequential scan.
--
-- Plain CREATE INDEX (not CONCURRENTLY), as in V6: Flyway runs each migration
-- in a transaction. The build takes a SHARE lock that blocks writes to
-- `orders`. The partial index is small, but building it still reads the whole
-- table, so run this migration outside an on-sale.
CREATE INDEX idx_orders_open_expires_at ON orders(expires_at)
  WHERE status IN ('CREATED', 'AWAITING_PAYMENT');
