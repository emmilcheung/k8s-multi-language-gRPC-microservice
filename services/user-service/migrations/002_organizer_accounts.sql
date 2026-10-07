CREATE TABLE IF NOT EXISTS organizer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_email text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  personal_for_user_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A user has at most one personal account; makes ensuring one race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS organizer_accounts_personal_for_user_id_key
  ON organizer_accounts (personal_for_user_id)
  WHERE personal_for_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('ORGANIZER_ACCOUNT', 'VENUE')),
  resource_id text NOT NULL,
  role text NOT NULL CHECK (
    role IN ('OWNER', 'ADMIN', 'EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF', 'VENUE_MANAGER')
  ),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_user_resource_key UNIQUE (user_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS memberships_resource_idx
  ON memberships (resource_type, resource_id);

-- Only meaningful for DOOR_STAFF; no rows means every event of the account.
CREATE TABLE IF NOT EXISTS membership_event_scopes (
  membership_id uuid NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  event_id text NOT NULL,
  PRIMARY KEY (membership_id, event_id)
);

-- The token itself is never stored, only its hash. Single use: status leaves
-- PENDING exactly once, when the invitation is accepted, revoked or expires.
CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES organizer_accounts (id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN', 'EVENT_MANAGER', 'FINANCE', 'DOOR_STAFF')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_by text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')
  ),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invitations_account_idx ON invitations (account_id);

CREATE TABLE IF NOT EXISTS venue_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id text NOT NULL,
  claimant_user_id text NOT NULL,
  claimant_account_id uuid REFERENCES organizer_accounts (id),
  evidence_text text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS venue_claims_venue_idx ON venue_claims (venue_id);
