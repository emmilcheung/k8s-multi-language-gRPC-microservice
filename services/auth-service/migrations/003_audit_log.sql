-- Append-only history of permission-checked changes. Same shape in every
-- service. before/after hold only the fields that changed.
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id text NOT NULL,
  actor_account_id text,
  action text NOT NULL,
  resource text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  trace_id text
);

CREATE INDEX IF NOT EXISTS audit_log_resource_at_idx
  ON audit_log (resource, at DESC);
