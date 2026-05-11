ALTER TABLE scan_events DROP CONSTRAINT IF EXISTS scan_events_result_check;
ALTER TABLE scan_events ADD CONSTRAINT scan_events_result_check
    CHECK (result IN ('ADMITTED', 'DENIED', 'ALREADY_USED', 'INVALID_TOKEN', 'POLICY_BLOCK'));
