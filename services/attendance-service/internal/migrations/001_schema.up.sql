-- Migration 001: attendance-service initial schema
--
-- Tables in dependency order:
--   event_attendance_policies
--   admission_credentials
--   scan_events

-- ── event_attendance_policies ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_attendance_policies (
    id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
    event_id             UUID        NOT NULL,
    ticket_id            UUID        NULL,
    organizer_id         UUID        NOT NULL,
    require_qr_for_entry BOOLEAN     NOT NULL DEFAULT true,
    allow_manual_override BOOLEAN    NOT NULL DEFAULT false,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT event_attendance_policies_pkey PRIMARY KEY (id),
    CONSTRAINT event_attendance_policies_event_ticket_unique UNIQUE (event_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_event_attendance_policies_event_id
    ON event_attendance_policies (event_id);

CREATE INDEX IF NOT EXISTS idx_event_attendance_policies_ticket_id
    ON event_attendance_policies (ticket_id)
    WHERE ticket_id IS NOT NULL;

-- ── admission_credentials ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admission_credentials (
    id               UUID        NOT NULL DEFAULT gen_random_uuid(),
    ticket_id        UUID        NOT NULL,
    order_id         UUID        NOT NULL,
    event_id         UUID        NOT NULL,
    token_version    INT         NOT NULL DEFAULT 1,
    token_id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    status           TEXT        NOT NULL DEFAULT 'ISSUED',
    issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at       TIMESTAMPTZ NULL,
    used_at          TIMESTAMPTZ NULL,
    used_by_user_id  UUID        NULL,
    used_by_device_id TEXT       NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT admission_credentials_pkey PRIMARY KEY (id),
    CONSTRAINT admission_credentials_status_check
        CHECK (status IN ('ISSUED', 'USED', 'REVOKED', 'EXPIRED')),
    CONSTRAINT admission_credentials_token_id_unique UNIQUE (token_id)
);

CREATE INDEX IF NOT EXISTS idx_admission_credentials_ticket_id
    ON admission_credentials (ticket_id);

CREATE INDEX IF NOT EXISTS idx_admission_credentials_event_id
    ON admission_credentials (event_id);

CREATE INDEX IF NOT EXISTS idx_admission_credentials_id
    ON admission_credentials (id);

CREATE INDEX IF NOT EXISTS idx_admission_credentials_status
    ON admission_credentials (status);

CREATE INDEX IF NOT EXISTS idx_admission_credentials_order_id
    ON admission_credentials (order_id);

-- ── scan_events ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scan_events (
    id               UUID        NOT NULL DEFAULT gen_random_uuid(),
    credential_id    UUID        NULL,
    event_id         UUID        NOT NULL,
    scanner_user_id  UUID        NOT NULL,
    device_id        TEXT        NOT NULL,
    gate_id          TEXT        NULL,
    mode             TEXT        NOT NULL,
    result           TEXT        NOT NULL,
    raw_token_hash   TEXT        NULL,
    scanned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT scan_events_pkey PRIMARY KEY (id),
    CONSTRAINT scan_events_mode_check
        CHECK (mode IN ('QR', 'MANUAL')),
    CONSTRAINT scan_events_result_check
        CHECK (result IN ('ADMITTED', 'DENIED', 'ALREADY_USED', 'INVALID_TOKEN', 'POLICY_BLOCK'))
);

CREATE INDEX IF NOT EXISTS idx_scan_events_credential_id
    ON scan_events (credential_id)
    WHERE credential_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scan_events_event_id
    ON scan_events (event_id);

CREATE INDEX IF NOT EXISTS idx_scan_events_result
    ON scan_events (result);

CREATE INDEX IF NOT EXISTS idx_scan_events_scanned_at
    ON scan_events (scanned_at);
