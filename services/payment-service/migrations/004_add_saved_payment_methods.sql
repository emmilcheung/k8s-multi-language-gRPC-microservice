CREATE TABLE IF NOT EXISTS payment_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_customer_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saved_payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  payment_customer_id UUID NOT NULL REFERENCES payment_customers(id),
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_payment_method_id TEXT NOT NULL UNIQUE,
  brand TEXT NOT NULL DEFAULT 'unknown',
  last4 TEXT NOT NULL DEFAULT '0000',
  exp_month INTEGER NOT NULL DEFAULT 1,
  exp_year INTEGER NOT NULL DEFAULT 1970,
  fingerprint TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  consent_given_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_saved_payment_methods_user_id
  ON saved_payment_methods (user_id);

CREATE INDEX IF NOT EXISTS idx_saved_payment_methods_user_default
  ON saved_payment_methods (user_id, is_default);

CREATE INDEX IF NOT EXISTS idx_saved_payment_methods_payment_customer_id
  ON saved_payment_methods (payment_customer_id);
