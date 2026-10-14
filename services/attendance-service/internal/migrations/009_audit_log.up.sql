-- Migration 009: append-only audit history
--
-- Same shape in every service. before/after hold only the fields that changed.
CREATE TABLE IF NOT EXISTS audit_log (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_user_id    TEXT NOT NULL,
    actor_account_id TEXT,
    action           TEXT NOT NULL,
    resource         TEXT NOT NULL,
    before           JSONB,
    after            JSONB,
    reason           TEXT,
    trace_id         TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource_at ON audit_log (resource, at DESC);
