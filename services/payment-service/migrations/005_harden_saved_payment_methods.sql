ALTER TABLE saved_payment_methods
  ADD COLUMN IF NOT EXISTS consent_version TEXT,
  ADD COLUMN IF NOT EXISTS consent_source TEXT,
  ADD COLUMN IF NOT EXISTS consent_ip_hash TEXT,
  ADD COLUMN IF NOT EXISTS consent_user_agent TEXT;

UPDATE saved_payment_methods
SET
  consent_version = COALESCE(consent_version, 'legacy-v0'),
  consent_source = COALESCE(consent_source, 'legacy-import'),
  consent_given_at = COALESCE(consent_given_at, created_at)
WHERE consent_version IS NULL
   OR consent_source IS NULL
   OR consent_given_at IS NULL;

ALTER TABLE saved_payment_methods
  ALTER COLUMN consent_given_at SET NOT NULL,
  ALTER COLUMN consent_given_at DROP DEFAULT,
  ALTER COLUMN consent_version SET NOT NULL,
  ALTER COLUMN consent_source SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_saved_payment_methods_single_default
  ON saved_payment_methods (user_id)
  WHERE is_default = true AND deleted_at IS NULL;
