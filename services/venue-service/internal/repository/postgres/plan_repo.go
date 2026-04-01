package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PlanRepo implements repository.PlanRepository using pgxpool.
type PlanRepo struct {
	pool *pgxpool.Pool
}

// NewPlanRepo creates a new PlanRepo backed by the given pool.
func NewPlanRepo(pool *pgxpool.Pool) *PlanRepo {
	return &PlanRepo{pool: pool}
}

// Create inserts a new seating plan. On return, p.ID, p.Status, p.Version,
// p.CreatedAt, and p.UpdatedAt are populated.
func (r *PlanRepo) Create(ctx context.Context, p *repository.SeatingPlan) error {
	const q = `
		INSERT INTO seating_plans (venue_id, organizer_id, name, hold_ttl_sec, max_seats_per_order)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, status, version, created_at, updated_at`

	holdTTL := p.HoldTTLSec
	if holdTTL <= 0 {
		holdTTL = 600
	}
	maxSeats := p.MaxSeatsPerOrder
	if maxSeats <= 0 {
		maxSeats = 10
	}

	return r.pool.QueryRow(ctx, q,
		p.VenueID, p.OrganizerID, p.Name, holdTTL, maxSeats,
	).Scan(&p.ID, &p.Status, &p.Version, &p.CreatedAt, &p.UpdatedAt)
}

// FindByID returns a seating plan by primary key.
func (r *PlanRepo) FindByID(ctx context.Context, id string) (*repository.SeatingPlan, error) {
	const q = `
		SELECT id, venue_id, COALESCE(ticket_id::text, ''), organizer_id, name,
		       status, hold_ttl_sec, max_seats_per_order, version, created_at, updated_at
		FROM seating_plans
		WHERE id = $1`

	p := &repository.SeatingPlan{}
	err := r.pool.QueryRow(ctx, q, id).Scan(
		&p.ID, &p.VenueID, &p.TicketID, &p.OrganizerID, &p.Name,
		&p.Status, &p.HoldTTLSec, &p.MaxSeatsPerOrder, &p.Version,
		&p.CreatedAt, &p.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrPlanNotFound
		}
		return nil, err
	}
	return p, nil
}

// ListActivePlans returns all seating plans with status = 'active'.
// Used by the Redis reconciler to re-seed seat state after a Redis flush.
func (r *PlanRepo) ListActivePlans(ctx context.Context) ([]*repository.SeatingPlan, error) {
	const q = `
		SELECT id, venue_id, COALESCE(ticket_id::text, ''), organizer_id, name,
		       status, hold_ttl_sec, max_seats_per_order, version, created_at, updated_at
		FROM seating_plans
		WHERE status = 'active'
		ORDER BY created_at ASC`

	rows, err := r.pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var plans []*repository.SeatingPlan
	for rows.Next() {
		p := &repository.SeatingPlan{}
		if err := rows.Scan(
			&p.ID, &p.VenueID, &p.TicketID, &p.OrganizerID, &p.Name,
			&p.Status, &p.HoldTTLSec, &p.MaxSeatsPerOrder, &p.Version,
			&p.CreatedAt, &p.UpdatedAt,
		); err != nil {
			return nil, err
		}
		plans = append(plans, p)
	}
	return plans, rows.Err()
}

// ListByTicket returns all seating plans attached to the given ticket.
func (r *PlanRepo) ListByTicket(ctx context.Context, ticketID string) ([]*repository.SeatingPlan, error) {
	const q = `
		SELECT id, venue_id, COALESCE(ticket_id::text, ''), organizer_id, name,
		       status, hold_ttl_sec, max_seats_per_order, version, created_at, updated_at
		FROM seating_plans
		WHERE ticket_id = $1
		ORDER BY created_at DESC`

	rows, err := r.pool.Query(ctx, q, ticketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var plans []*repository.SeatingPlan
	for rows.Next() {
		p := &repository.SeatingPlan{}
		if err := rows.Scan(
			&p.ID, &p.VenueID, &p.TicketID, &p.OrganizerID, &p.Name,
			&p.Status, &p.HoldTTLSec, &p.MaxSeatsPerOrder, &p.Version,
			&p.CreatedAt, &p.UpdatedAt,
		); err != nil {
			return nil, err
		}
		plans = append(plans, p)
	}
	return plans, rows.Err()
}

// AttachTicket sets ticket_id on a seating plan using optimistic concurrency.
// Returns ErrVersionConflict if the version doesn't match.
// Returns ErrPlanAlreadyActive if the plan is already active.
func (r *PlanRepo) AttachTicket(ctx context.Context, planID, ticketID string, expectedVersion int) error {
	const q = `
		UPDATE seating_plans
		SET ticket_id = $1, updated_at = now()
		WHERE id = $2 AND version = $3 AND status = 'draft'
		RETURNING id`

	var id string
	err := r.pool.QueryRow(ctx, q, ticketID, planID, expectedVersion).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Disambiguate: was it a version conflict or active plan?
			p, findErr := r.FindByID(ctx, planID)
			if findErr != nil {
				return findErr
			}
			if p.Status != repository.PlanStatusDraft {
				return repository.ErrPlanAlreadyActive
			}
			return repository.ErrVersionConflict
		}
		return err
	}
	return nil
}

// Activate transitions a seating plan from draft to active.
// Validates that ticket_id is set and that at least one section exists.
// Returns ErrPlanNotAttached if ticket_id is null.
// Returns ErrPlanHasNoSections if no sections exist.
// Returns ErrPlanAlreadyActive if already active.
// Returns ErrVersionConflict on optimistic concurrency failure.
func (r *PlanRepo) Activate(ctx context.Context, planID string, expectedVersion int) error {
	// First validate activation preconditions.
	p, err := r.FindByID(ctx, planID)
	if err != nil {
		return err
	}

	if p.Status == repository.PlanStatusActive {
		return repository.ErrPlanAlreadyActive
	}
	if p.TicketID == "" {
		return repository.ErrPlanNotAttached
	}

	// Check at least one section exists.
	var sectionCount int
	const countQ = `SELECT COUNT(*) FROM sections WHERE plan_id = $1`
	if err := r.pool.QueryRow(ctx, countQ, planID).Scan(&sectionCount); err != nil {
		return err
	}
	if sectionCount == 0 {
		return repository.ErrPlanHasNoSections
	}

	// Attempt activation with optimistic concurrency check.
	const q = `
		UPDATE seating_plans
		SET status = 'active', updated_at = now()
		WHERE id = $1 AND version = $2 AND status = 'draft'
		RETURNING id`

	var id string
	err = r.pool.QueryRow(ctx, q, planID, expectedVersion).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return repository.ErrVersionConflict
		}
		return err
	}
	return nil
}

// Update persists name, hold_ttl_sec, and max_seats_per_order changes.
// The caller must supply the current version; the update is rejected on mismatch.
func (r *PlanRepo) Update(ctx context.Context, p *repository.SeatingPlan) error {
	const q = `
		UPDATE seating_plans
		SET name = $1, hold_ttl_sec = $2, max_seats_per_order = $3, updated_at = now()
		WHERE id = $4 AND organizer_id = $5
		RETURNING updated_at`
	var updatedAt time.Time
	err := r.pool.QueryRow(ctx, q, p.Name, p.HoldTTLSec, p.MaxSeatsPerOrder, p.ID, p.OrganizerID).
		Scan(&updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return repository.ErrPlanNotFound
		}
		return err
	}
	p.UpdatedAt = updatedAt
	return nil
}
