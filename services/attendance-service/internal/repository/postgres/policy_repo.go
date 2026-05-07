package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PolicyRepo implements repository.PolicyRepository using pgxpool.
type PolicyRepo struct {
	db *pgxpool.Pool
}

// NewPolicyRepo creates a new PolicyRepo.
func NewPolicyRepo(db *pgxpool.Pool) *PolicyRepo {
	return &PolicyRepo{db: db}
}

// FindByEventID returns the attendance policy for a given event (ticket_id IS NULL row).
func (r *PolicyRepo) FindByEventID(ctx context.Context, eventID string) (*repository.AttendancePolicy, error) {
	const q = `
		SELECT id, event_id, ticket_id, organizer_id,
		       require_qr_for_entry, allow_manual_override,
		       created_at, updated_at
		FROM event_attendance_policies
		WHERE event_id = $1 AND ticket_id IS NULL
		LIMIT 1`

	row := r.db.QueryRow(ctx, q, eventID)
	var p repository.AttendancePolicy
	err := row.Scan(
		&p.ID, &p.EventID, &p.TicketID, &p.OrganizerID,
		&p.RequireQRForEntry, &p.AllowManualOverride,
		&p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, fmt.Errorf("policy_repo: find by event_id: %w", err)
	}
	return &p, nil
}

// Upsert inserts or updates an attendance policy.
func (r *PolicyRepo) Upsert(ctx context.Context, policy *repository.AttendancePolicy) error {
	const q = `
		INSERT INTO event_attendance_policies
		    (id, event_id, ticket_id, organizer_id, require_qr_for_entry, allow_manual_override)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (event_id, ticket_id)
		    DO UPDATE SET
		        require_qr_for_entry  = EXCLUDED.require_qr_for_entry,
		        allow_manual_override = EXCLUDED.allow_manual_override,
		        updated_at            = now()`

	_, err := r.db.Exec(ctx, q,
		policy.ID, policy.EventID, policy.TicketID, policy.OrganizerID,
		policy.RequireQRForEntry, policy.AllowManualOverride,
	)
	if err != nil {
		return fmt.Errorf("policy_repo: upsert: %w", err)
	}
	return nil
}
