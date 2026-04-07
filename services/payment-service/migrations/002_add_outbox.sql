-- payment-service outbox table migration
-- Adds the transactional outbox table for reliable event publishing.
-- Payments write their Kafka event to this table atomically (same DB transaction as
-- the payment status update). A cron relay reads unpublished rows and sends them to Kafka.

CREATE TABLE IF NOT EXISTS outbox (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic         TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  trace_headers JSONB       NOT NULL DEFAULT '{}',
  partition_key TEXT        NOT NULL,
  published     BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index — only unpublished rows need scanning by the relay
CREATE INDEX IF NOT EXISTS idx_payment_outbox_unpublished
  ON outbox (created_at)
  WHERE published = false;
