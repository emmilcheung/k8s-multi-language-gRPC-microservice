package postgres

import (
	"context"
	"encoding/json"
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
// p.LayoutJSON, p.CreatedAt, p.UpdatedAt, and mode defaults are populated.
func (r *PlanRepo) Create(ctx context.Context, p *repository.SeatingPlan) error {
	const q = `
		INSERT INTO seating_plans (venue_id, organizer_id, name, max_seats_per_order, assignment_mode, pricing_mode)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, status, layout_json, version, assignment_mode, pricing_mode, created_at, updated_at`

	maxSeats := p.MaxSeatsPerOrder
	if maxSeats <= 0 {
		maxSeats = 10
	}

	assignmentMode := p.AssignmentMode
	if assignmentMode == "" {
		assignmentMode = "manual"
	}

	pricingMode := p.PricingMode
	if pricingMode == "" {
		pricingMode = "single"
	}

	return r.pool.QueryRow(ctx, q,
		p.VenueID, p.OrganizerID, p.Name, maxSeats, assignmentMode, pricingMode,
	).Scan(&p.ID, &p.Status, &p.LayoutJSON, &p.Version, &p.AssignmentMode, &p.PricingMode, &p.CreatedAt, &p.UpdatedAt)
}

// FindByID returns a seating plan by primary key.
func (r *PlanRepo) FindByID(ctx context.Context, id string) (*repository.SeatingPlan, error) {
	const q = `
		SELECT id, venue_id, COALESCE(ticket_id::text, ''), organizer_id, name,
		       status, max_seats_per_order, layout_json, version, assignment_mode, pricing_mode, created_at, updated_at
		FROM seating_plans
		WHERE id = $1`

	p := &repository.SeatingPlan{}
	err := r.pool.QueryRow(ctx, q, id).Scan(
		&p.ID, &p.VenueID, &p.TicketID, &p.OrganizerID, &p.Name,
		&p.Status, &p.MaxSeatsPerOrder, &p.LayoutJSON, &p.Version, &p.AssignmentMode, &p.PricingMode,
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

// ListByVenue returns all seating plans for the given venue belonging to the organizer,
// ordered newest-first.
func (r *PlanRepo) ListByVenue(ctx context.Context, venueID, organizerID string) ([]*repository.SeatingPlan, error) {
	const q = `
		SELECT id, venue_id, COALESCE(ticket_id::text, ''), organizer_id, name,
		       status, max_seats_per_order, layout_json, version, assignment_mode, pricing_mode, created_at, updated_at
		FROM seating_plans
		WHERE venue_id = $1 AND organizer_id = $2
		ORDER BY created_at DESC`

	rows, err := r.pool.Query(ctx, q, venueID, organizerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var plans []*repository.SeatingPlan
	for rows.Next() {
		p := &repository.SeatingPlan{}
		if err := rows.Scan(
			&p.ID, &p.VenueID, &p.TicketID, &p.OrganizerID, &p.Name,
			&p.Status, &p.MaxSeatsPerOrder, &p.LayoutJSON, &p.Version, &p.AssignmentMode, &p.PricingMode,
			&p.CreatedAt, &p.UpdatedAt,
		); err != nil {
			return nil, err
		}
		plans = append(plans, p)
	}
	return plans, rows.Err()
}

// ListActivePlans returns all seating plans with status = 'active'.
// Used by the Redis reconciler to re-seed seat state after a Redis flush.
func (r *PlanRepo) ListActivePlans(ctx context.Context) ([]*repository.SeatingPlan, error) {
	const q = `
		SELECT id, venue_id, COALESCE(ticket_id::text, ''), organizer_id, name,
		       status, max_seats_per_order, layout_json, version, assignment_mode, pricing_mode, created_at, updated_at
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
			&p.Status, &p.MaxSeatsPerOrder, &p.LayoutJSON, &p.Version, &p.AssignmentMode, &p.PricingMode,
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
		       status, max_seats_per_order, layout_json, version, assignment_mode, pricing_mode, created_at, updated_at
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
			&p.Status, &p.MaxSeatsPerOrder, &p.LayoutJSON, &p.Version, &p.AssignmentMode, &p.PricingMode,
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
		SET ticket_id = $1, version = version + 1, updated_at = now()
		WHERE id = $2 AND version = $3 AND status IN ('draft', 'active')
		RETURNING id`

	var id string
	err := r.pool.QueryRow(ctx, q, ticketID, planID, expectedVersion).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Disambiguate: version conflict or inactive plan?
			p, findErr := r.FindByID(ctx, planID)
			if findErr != nil {
				return findErr
			}
			if p.Status == repository.PlanStatusInactive {
				return repository.ErrPlanNotActive
			}
			return repository.ErrVersionConflict
		}
		return err
	}
	return nil
}

// Activate transitions a seating plan from draft to active.
// Validates that at least one section exists.
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

// Deactivate transitions an active seating plan to inactive status.
// Only the plan owner may deactivate, and the plan must currently be active.
// Returns ErrPlanNotFound if the plan does not exist or is not owned by organizerID.
// Returns ErrPlanNotActive if the plan is not currently active.
func (r *PlanRepo) Deactivate(ctx context.Context, planID, organizerID string) error {
	p, err := r.FindByID(ctx, planID)
	if err != nil {
		return err
	}
	if p.OrganizerID != organizerID {
		return repository.ErrPlanNotFound // surface as 404 to prevent probing
	}
	if p.Status != repository.PlanStatusActive {
		return repository.ErrPlanNotActive
	}

	const q = `
		UPDATE seating_plans
		SET status = 'inactive', updated_at = now()
		WHERE id = $1 AND organizer_id = $2 AND status = 'active'
		RETURNING id`

	var id string
	err = r.pool.QueryRow(ctx, q, planID, organizerID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return repository.ErrPlanNotActive
		}
		return err
	}
	return nil
}

// Update persists name, max_seats_per_order, assignment_mode, and pricing_mode changes.
// The caller must supply the current version; the update is rejected on mismatch.
func (r *PlanRepo) Update(ctx context.Context, p *repository.SeatingPlan) error {
	const q = `
		UPDATE seating_plans
		SET name = $1, max_seats_per_order = $2, assignment_mode = $3, pricing_mode = $4, updated_at = now()
		WHERE id = $5 AND organizer_id = $6
		RETURNING updated_at`
	var updatedAt time.Time

	assignmentMode := p.AssignmentMode
	if assignmentMode == "" {
		assignmentMode = "manual"
	}

	pricingMode := p.PricingMode
	if pricingMode == "" {
		pricingMode = "single"
	}

	err := r.pool.QueryRow(ctx, q, p.Name, p.MaxSeatsPerOrder, assignmentMode, pricingMode, p.ID, p.OrganizerID).
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

// SaveLayout persists a free-form layout_json blob for the given draft plan.
// Only the owner may save the layout, and the plan must still be in 'draft' status.
func (r *PlanRepo) SaveLayout(ctx context.Context, planID, organizerID string, layoutJSON json.RawMessage) error {
	if len(layoutJSON) == 0 {
		layoutJSON = json.RawMessage("{}")
	}
	const q = `
		UPDATE seating_plans
		SET layout_json = $1, updated_at = now()
		WHERE id = $2 AND organizer_id = $3 AND status = 'draft'
		RETURNING id`

	var id string
	err := r.pool.QueryRow(ctx, q, layoutJSON, planID, organizerID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Could be not found, wrong organizer, or not in draft.
			p, findErr := r.FindByID(ctx, planID)
			if findErr != nil {
				return findErr
			}
			if p.OrganizerID != organizerID {
				return repository.ErrPlanNotFound // surface as 404, not 403
			}
			return repository.ErrPlanAlreadyActive // plan is not draft
		}
		return err
	}
	return nil
}
