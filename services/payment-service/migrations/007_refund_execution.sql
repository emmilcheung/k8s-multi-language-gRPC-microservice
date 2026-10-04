-- Refund rows are the work queue the refund executor drains. These columns
-- track retries and completion; a row stays 'requested' until the provider
-- confirms the refund.
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_refunds_due
  ON refunds (next_attempt_at)
  WHERE status = 'requested';

-- At most one live refund per order, so a redelivered event or a double click
-- can never refund the same order twice. A failed refund does not count, so it
-- can be requested again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_refunds_one_live_per_order
  ON refunds (order_id)
  WHERE status IN ('requested', 'processing', 'completed');
