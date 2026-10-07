-- Migration 010: new venues start UNVERIFIED
--
-- Migration 008 made every existing venue VERIFIED (they are in use) and left
-- the column default at VERIFIED until creation wrote the status itself. It
-- does now, so the default moves to UNVERIFIED; rows already stored keep their
-- status.
ALTER TABLE venues ALTER COLUMN status SET DEFAULT 'UNVERIFIED';
