CREATE TABLE IF NOT EXISTS admission_transfers (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    credential_id UUID NOT NULL REFERENCES admission_credentials(id) ON DELETE CASCADE,
    sender_user_id UUID NOT NULL,
    recipient_user_id UUID NULL,
    recipient_email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at TIMESTAMPTZ NULL,
    recalled_at TIMESTAMPTZ NULL,
    CONSTRAINT admission_transfers_pkey PRIMARY KEY (id),
    CONSTRAINT admission_transfers_state_check CHECK (state IN ('PENDING', 'ACCEPTED', 'RECALLED'))
);

CREATE INDEX IF NOT EXISTS idx_admission_transfers_credential_id
    ON admission_transfers (credential_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admission_transfers_recipient_email
    ON admission_transfers (recipient_email, created_at DESC);
