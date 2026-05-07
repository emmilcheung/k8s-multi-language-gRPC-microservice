package postgres

import (
	"context"
	"fmt"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ScanRepo implements repository.ScanEventRepository using pgxpool.
type ScanRepo struct {
	db *pgxpool.Pool
}

// NewScanRepo creates a new ScanRepo.
func NewScanRepo(db *pgxpool.Pool) *ScanRepo {
	return &ScanRepo{db: db}
}

// Create inserts a new scan event record.
func (r *ScanRepo) Create(ctx context.Context, event *repository.ScanEvent) error {
	const q = `
		INSERT INTO scan_events
		    (id, credential_id, event_id, scanner_user_id, device_id, gate_id, mode, result, raw_token_hash, scanned_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`

	_, err := r.db.Exec(ctx, q,
		event.ID, event.CredentialID, event.EventID,
		event.ScannerUserID, event.DeviceID, event.GateID,
		string(event.Mode), string(event.Result),
		event.RawTokenHash, event.ScannedAt,
	)
	if err != nil {
		return fmt.Errorf("scan_repo: create: %w", err)
	}
	return nil
}

// SummarizeByEventID aggregates scan event outcomes for an event.
func (r *ScanRepo) SummarizeByEventID(ctx context.Context, eventID string) (*repository.AttendanceSummary, error) {
	// WS1 has no dedicated check-in scan result; only ADMITTED / DENIED variants
	// are tracked.  total_checked_in is therefore intentionally an alias for
	// total_admitted at this stage.
	// TODO(WS2): add a CHECK_IN result column, compute total_checked_in via its
	// own COUNT(*) FILTER, and update the test
	// TestGetAttendanceSummary_WS1_TotalCheckedInEqualsTotalAdmitted.
	const q = `
		SELECT
		    COUNT(*) FILTER (WHERE result = 'ADMITTED')  AS total_admitted,
		    COUNT(*) FILTER (WHERE result = 'DENIED'
		                        OR result = 'POLICY_BLOCK'
		                        OR result = 'INVALID_TOKEN') AS total_denied
		FROM scan_events
		WHERE event_id = $1`

	summary := &repository.AttendanceSummary{EventID: eventID}
	err := r.db.QueryRow(ctx, q, eventID).Scan(
		&summary.TotalAdmitted,
		&summary.TotalDenied,
	)
	if err != nil {
		return nil, fmt.Errorf("scan_repo: summarize: %w", err)
	}
	// WS1: mirror admitted count; WS2 replaces this with a real check-in count.
	summary.TotalCheckedIn = summary.TotalAdmitted
	return summary, nil
}
