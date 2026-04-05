-- V3__add_seated_order_support.sql
-- CP-12: Add seated-order support to the orders service.
--
-- Changes:
--   1. Add `order_type` to `orders` to distinguish GA vs MANUAL_SEATED vs AUTO_ASSIGN_SEATED.
--      Defaults to 'GA' for backward compatibility with all existing rows.
--   2. Add `plan_id` (nullable) so seated orders carry the venue seating plan reference.
--   3. Add `section_id` (nullable) for auto-assign orders that target a specific section.
--   4. Create `order_seats` child table: one row per seat in a seated order.
--
-- All column additions are additive (nullable or with DEFAULT) so this migration is safe
-- for a live zero-downtime deployment before the application is upgraded.

-- 1. order_type discriminator
ALTER TABLE orders
    ADD COLUMN order_type VARCHAR(30) NOT NULL DEFAULT 'GA';

ALTER TABLE orders
    ADD CONSTRAINT ck_orders_order_type
        CHECK (order_type IN ('GA', 'MANUAL_SEATED', 'AUTO_ASSIGN_SEATED'));

-- 2. plan_id for seated orders
ALTER TABLE orders
    ADD COLUMN plan_id UUID NULL;

-- 3. section_id for auto-assign orders
ALTER TABLE orders
    ADD COLUMN section_id UUID NULL;

-- 4. order_seats child table
CREATE TABLE order_seats (
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    order_id        UUID        NOT NULL,
    seat_id         UUID        NOT NULL,
    section_id      UUID        NOT NULL,
    seat_label      TEXT        NOT NULL,
    price           NUMERIC(12, 2) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pk_order_seats PRIMARY KEY (id),
    CONSTRAINT fk_order_seats_order
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT ck_order_seats_price_non_negative
        CHECK (price >= 0)
);

-- Index: look up seats by order (join from order detail page)
CREATE INDEX idx_order_seats_order_id ON order_seats (order_id);

-- Unique guard: a seat cannot appear twice in the same order
CREATE UNIQUE INDEX uq_order_seats_order_seat
    ON order_seats (order_id, seat_id);
