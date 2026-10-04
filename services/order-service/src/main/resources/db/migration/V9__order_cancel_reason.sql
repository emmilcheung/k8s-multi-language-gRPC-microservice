-- Why an order was cancelled, so the client can tell "refunded" apart from
-- "expired". NULL while the order is not cancelled, and for orders cancelled
-- before this column existed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(40);
