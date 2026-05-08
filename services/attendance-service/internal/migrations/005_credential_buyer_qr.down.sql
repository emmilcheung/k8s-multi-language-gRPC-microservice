DROP INDEX IF EXISTS idx_admission_credentials_ticket_buyer_issued_at;

ALTER TABLE admission_credentials
    DROP COLUMN IF EXISTS qr_token,
    DROP COLUMN IF EXISTS buyer_user_id;
