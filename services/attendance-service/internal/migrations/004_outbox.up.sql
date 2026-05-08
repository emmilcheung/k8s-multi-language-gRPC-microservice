-- Migration 004: add transactional outbox for durable attendance.qr.issued relaying

CREATE TABLE IF NOT EXISTS outbox (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    topic         TEXT        NOT NULL,
    payload       JSONB       NOT NULL,
    trace_headers JSONB       NOT NULL DEFAULT '{}',
    partition_key TEXT        NOT NULL,
    published     BOOLEAN     NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_outbox_unpublished
    ON outbox (created_at)
    WHERE published = false;
