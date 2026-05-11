-- 006 — Add VALIDATED to the scan_events.result enum.
-- Validate-mode scans must not be conflated with ADMITTED check-ins.

ALTER TABLE scan_events DROP CONSTRAINT IF EXISTS scan_events_result_check;
ALTER TABLE scan_events ADD CONSTRAINT scan_events_result_check
    CHECK (result IN ('ADMITTED', 'DENIED', 'ALREADY_USED', 'INVALID_TOKEN', 'POLICY_BLOCK', 'VALIDATED'));
