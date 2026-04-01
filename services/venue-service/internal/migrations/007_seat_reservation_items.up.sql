-- Migration 007: seat_reservation_items table
-- One row per seat within a reservation. Price is snapshotted at reservation time
-- so that price tier changes after reservation do not affect existing orders.

CREATE TABLE IF NOT EXISTS seat_reservation_items (
    reservation_id UUID          NOT NULL REFERENCES seat_reservations (id) ON DELETE CASCADE,
    seat_id        UUID          NOT NULL REFERENCES seats (id),
    section_id     UUID          NOT NULL REFERENCES sections (id),
    price          NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    seat_label     TEXT          NOT NULL,
    PRIMARY KEY (reservation_id, seat_id)
);

CREATE INDEX IF NOT EXISTS idx_reservation_items_reservation_id ON seat_reservation_items (reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_items_seat_id        ON seat_reservation_items (seat_id);
