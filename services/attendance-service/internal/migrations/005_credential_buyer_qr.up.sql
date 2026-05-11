ALTER TABLE admission_credentials
    ADD COLUMN IF NOT EXISTS buyer_user_id UUID NULL,
    ADD COLUMN IF NOT EXISTS qr_token TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_admission_credentials_ticket_buyer_issued_at
    ON admission_credentials (ticket_id, buyer_user_id, issued_at DESC)
    WHERE buyer_user_id IS NOT NULL;
