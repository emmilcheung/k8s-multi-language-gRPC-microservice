package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SectionRepo implements repository.SectionRepository using pgxpool.
type SectionRepo struct {
	pool *pgxpool.Pool
}

// NewSectionRepo creates a new SectionRepo backed by the given pool.
func NewSectionRepo(pool *pgxpool.Pool) *SectionRepo {
	return &SectionRepo{pool: pool}
}

// CreateSection inserts a new section. On return, s.ID, s.CreatedAt, s.UpdatedAt are populated.
func (r *SectionRepo) CreateSection(ctx context.Context, s *repository.Section) error {
	const q = `
		INSERT INTO sections (plan_id, name, type, row_count, column_count, price_tier_id)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::uuid)
		RETURNING id, created_at, updated_at`
	return r.pool.QueryRow(ctx, q, s.PlanID, s.Name, s.Type, s.RowCount, s.ColumnCount, s.PriceTierID).
		Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
}

// BulkInsertSeats auto-generates seat rows for a newly created section using a
// pgx batch to avoid N round-trips. priceTierID is optional; pass "" for NULL.
func (r *SectionRepo) BulkInsertSeats(ctx context.Context, sectionID, planID, sectionType, priceTierID string, rowCount, columnCount int) error {
	const q = `
		INSERT INTO seats (section_id, plan_id, seat_label, row_label, column_number, price_tier_id, attributes)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::uuid, $7)`

	batch := &pgx.Batch{}

	switch sectionType {
	case string(repository.SectionTypeSeated):
		for r := 1; r <= rowCount; r++ {
			for c := 1; c <= columnCount; c++ {
				label := fmt.Sprintf("R%dS%d", r, c)
				rowLabel := fmt.Sprintf("R%d", r)
				batch.Queue(q, sectionID, planID, label, rowLabel, c, priceTierID, "{}")
			}
		}
	case string(repository.SectionTypeGA):
		for i := 1; i <= columnCount; i++ {
			label := fmt.Sprintf("GA%d", i)
			batch.Queue(q, sectionID, planID, label, "GA", i, priceTierID, "{}")
		}
	default:
		return fmt.Errorf("unknown section type: %s", sectionType)
	}

	if batch.Len() == 0 {
		return nil
	}

	br := r.pool.SendBatch(ctx, batch)
	defer br.Close()

	for i := 0; i < batch.Len(); i++ {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

// ProvisionFromVenue clones venue template sections into plan-scoped sections and
// generates seat rows for each.  Idempotent: returns (0, nil) if the plan already
// has sections.  Returns the count of sections provisioned.
func (r *SectionRepo) ProvisionFromVenue(ctx context.Context, planID, venueID string) (int, error) {
	// Check idempotency: if plan already has sections, do nothing.
	var existing int
	if err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sections WHERE plan_id = $1`, planID,
	).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}

	// Fetch venue template sections ordered by display_order.
	const vsQ = `
		SELECT id, name, type, row_count, column_count
		FROM   venue_sections
		WHERE  venue_id = $1
		ORDER  BY display_order, created_at`

	rows, err := r.pool.Query(ctx, vsQ, venueID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type templateSection struct {
		id          string
		name        string
		sectionType string
		rowCount    int
		colCount    int
	}
	var templates []templateSection
	for rows.Next() {
		var ts templateSection
		if err := rows.Scan(&ts.id, &ts.name, &ts.sectionType, &ts.rowCount, &ts.colCount); err != nil {
			return 0, err
		}
		templates = append(templates, ts)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	if len(templates) == 0 {
		return 0, nil
	}

	// Clone each template section into the plan.
	for _, ts := range templates {
		s := &repository.Section{
			PlanID:      planID,
			Name:        ts.name,
			Type:        repository.SectionType(ts.sectionType),
			RowCount:    ts.rowCount,
			ColumnCount: ts.colCount,
		}
		if err := r.CreateSection(ctx, s); err != nil {
			return 0, fmt.Errorf("provision section %q: %w", ts.name, err)
		}
		if err := r.BulkInsertSeats(ctx, s.ID, planID, ts.sectionType, "", ts.rowCount, ts.colCount); err != nil {
			return 0, fmt.Errorf("provision seats for section %q: %w", ts.name, err)
		}
	}

	return len(templates), nil
}

func (r *SectionRepo) FindSectionByID(ctx context.Context, id string) (*repository.Section, error) {
	const q = `
		SELECT id, plan_id, name, type, row_count, column_count, COALESCE(price_tier_id::text, ''), created_at, updated_at
		FROM sections
		WHERE id = $1`
	s := &repository.Section{}
	err := r.pool.QueryRow(ctx, q, id).
		Scan(&s.ID, &s.PlanID, &s.Name, &s.Type, &s.RowCount, &s.ColumnCount, &s.PriceTierID, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrSectionNotFound
		}
		return nil, err
	}
	return s, nil
}

// ListSectionsByPlan returns all sections for a seating plan.
func (r *SectionRepo) ListSectionsByPlan(ctx context.Context, planID string) ([]*repository.Section, error) {
	const q = `
		SELECT id, plan_id, name, type, row_count, column_count, COALESCE(price_tier_id::text, ''), created_at, updated_at
		FROM sections
		WHERE plan_id = $1
		ORDER BY created_at ASC`
	rows, err := r.pool.Query(ctx, q, planID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sections []*repository.Section
	for rows.Next() {
		s := &repository.Section{}
		if err := rows.Scan(&s.ID, &s.PlanID, &s.Name, &s.Type, &s.RowCount, &s.ColumnCount, &s.PriceTierID, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		sections = append(sections, s)
	}
	return sections, rows.Err()
}

// UpsertSeat creates or updates a seat. ID is used for upsert key.
// On insert, seat.ID, seat.CreatedAt, seat.UpdatedAt are populated.
func (r *SectionRepo) UpsertSeat(ctx context.Context, seat *repository.Seat) error {
	const q = `
		INSERT INTO seats (section_id, plan_id, price_tier_id, seat_label, row_label, column_number, attributes)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE
		SET seat_label    = EXCLUDED.seat_label,
		    row_label     = EXCLUDED.row_label,
		    column_number = EXCLUDED.column_number,
		    price_tier_id = EXCLUDED.price_tier_id,
		    attributes    = EXCLUDED.attributes,
		    updated_at    = now()
		RETURNING id, status, version, created_at, updated_at`

	attrs := seat.Attributes
	if attrs == "" {
		attrs = "{}"
	}

	return r.pool.QueryRow(ctx, q,
		seat.SectionID, seat.PlanID, seat.PriceTierID,
		seat.SeatLabel, seat.RowLabel, seat.ColumnNumber, attrs,
	).Scan(&seat.ID, &seat.Status, &seat.Version, &seat.CreatedAt, &seat.UpdatedAt)
}

// FindSeatsBySection returns all seats in a section, ordered by row+column.
func (r *SectionRepo) FindSeatsBySection(ctx context.Context, sectionID string) ([]*repository.Seat, error) {
	const q = `
		SELECT id, section_id, plan_id, price_tier_id, seat_label, row_label,
		       column_number, status, COALESCE(held_by::text,''), held_until,
		       attributes::text, version, created_at, updated_at
		FROM seats
		WHERE section_id = $1
		ORDER BY row_label ASC, column_number ASC`
	return r.scanSeats(ctx, q, sectionID)
}

// FindSeatsByIDs returns seats matching the given IDs. Order is not guaranteed.
func (r *SectionRepo) FindSeatsByIDs(ctx context.Context, seatIDs []string) ([]*repository.Seat, error) {
	if len(seatIDs) == 0 {
		return nil, nil
	}
	const q = `
		SELECT id, section_id, plan_id, price_tier_id, seat_label, row_label,
		       column_number, status, COALESCE(held_by::text,''), held_until,
		       attributes::text, version, created_at, updated_at
		FROM seats
		WHERE id = ANY($1)`
	return r.scanSeats(ctx, q, seatIDs)
}

// GetAvailableSeatsInSection returns all AVAILABLE seats in the given section.
func (r *SectionRepo) GetAvailableSeatsInSection(ctx context.Context, sectionID string) ([]*repository.Seat, error) {
	const q = `
		SELECT id, section_id, plan_id, price_tier_id, seat_label, row_label,
		       column_number, status, COALESCE(held_by::text,''), held_until,
		       attributes::text, version, created_at, updated_at
		FROM seats
		WHERE section_id = $1 AND status = 'AVAILABLE'
		ORDER BY row_label ASC, column_number ASC`
	return r.scanSeats(ctx, q, sectionID)
}

// HoldSeats atomically transitions seats AVAILABLE → HELD for the given user.
// Uses a FOR UPDATE lock to prevent concurrent hold races.
// Returns ErrSeatNotAvailable if any seat is not AVAILABLE.
func (r *SectionRepo) HoldSeats(ctx context.Context, seatIDs []string, userID string, expiresAt time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Lock all target seats for update.
	const lockQ = `
		SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE`
	rows, err := tx.Query(ctx, lockQ, seatIDs)
	if err != nil {
		return err
	}
	locked := make(map[string]string, len(seatIDs))
	for rows.Next() {
		var id, status string
		if err := rows.Scan(&id, &status); err != nil {
			rows.Close()
			return err
		}
		locked[id] = status
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// Verify all seats exist and are AVAILABLE.
	for _, id := range seatIDs {
		st, ok := locked[id]
		if !ok || st != string(repository.SeatStatusAvailable) {
			return repository.ErrSeatNotAvailable
		}
	}

	// Apply transition.
	const updateQ = `
		UPDATE seats
		SET status     = 'HELD',
		    held_by    = $1,
		    held_until = $2,
		    version    = version + 1,
		    updated_at = now()
		WHERE id = ANY($3)`
	if _, err := tx.Exec(ctx, updateQ, userID, expiresAt, seatIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReleaseHold releases HELD seats back to AVAILABLE for the given user.
// Seats not held by the user are silently skipped (idempotent-friendly).
func (r *SectionRepo) ReleaseHold(ctx context.Context, seatIDs []string, userID string) error {
	const q = `
		UPDATE seats
		SET status     = 'AVAILABLE',
		    held_by    = NULL,
		    held_until = NULL,
		    version    = version + 1,
		    updated_at = now()
		WHERE id = ANY($1) AND held_by = $2 AND status = 'HELD'`
	_, err := r.pool.Exec(ctx, q, seatIDs, userID)
	return err
}

// ReserveSeats atomically transitions HELD or AVAILABLE seats → RESERVED.
// The reservationID is stored in the seat's held_by column as a projection
// (the reservation ledger is the durable authority).
// Returns ErrSeatNotAvailable if any seat cannot be reserved.
func (r *SectionRepo) ReserveSeats(ctx context.Context, seatIDs []string, reservationID string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	const lockQ = `SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE`
	rows, err := tx.Query(ctx, lockQ, seatIDs)
	if err != nil {
		return err
	}
	locked := make(map[string]string, len(seatIDs))
	for rows.Next() {
		var id, status string
		if err := rows.Scan(&id, &status); err != nil {
			rows.Close()
			return err
		}
		locked[id] = status
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, id := range seatIDs {
		st, ok := locked[id]
		if !ok {
			return repository.ErrSeatNotAvailable
		}
		if st != string(repository.SeatStatusHeld) && st != string(repository.SeatStatusAvailable) {
			return repository.ErrSeatNotAvailable
		}
	}

	const updateQ = `
		UPDATE seats
		SET status     = 'RESERVED',
		    held_by    = $1,
		    held_until = NULL,
		    version    = version + 1,
		    updated_at = now()
		WHERE id = ANY($2)`
	if _, err := tx.Exec(ctx, updateQ, reservationID, seatIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReleaseReservedSeats transitions RESERVED seats → AVAILABLE.
func (r *SectionRepo) ReleaseReservedSeats(ctx context.Context, seatIDs []string) error {
	const q = `
		UPDATE seats
		SET status     = 'AVAILABLE',
		    held_by    = NULL,
		    held_until = NULL,
		    version    = version + 1,
		    updated_at = now()
		WHERE id = ANY($1) AND status = 'RESERVED'`
	_, err := r.pool.Exec(ctx, q, seatIDs)
	return err
}

// SellSeats transitions RESERVED seats → SOLD (terminal).
func (r *SectionRepo) SellSeats(ctx context.Context, seatIDs []string) error {
	const q = `
		UPDATE seats
		SET status     = 'SOLD',
		    version    = version + 1,
		    updated_at = now()
		WHERE id = ANY($1) AND status = 'RESERVED'`
	_, err := r.pool.Exec(ctx, q, seatIDs)
	return err
}

// SweepExpiredHolds releases all HELD seats whose held_until timestamp has
// already passed. Called periodically by the hold sweeper goroutine.
// Returns the number of seats released.
func (r *SectionRepo) SweepExpiredHolds(ctx context.Context) (int64, error) {
	const q = `
		UPDATE seats
		SET status     = 'AVAILABLE',
		    held_by    = NULL,
		    held_until = NULL,
		    version    = version + 1,
		    updated_at = now()
		WHERE status = 'HELD'
		  AND held_until < now()`
	tag, err := r.pool.Exec(ctx, q)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ── internal helpers ──────────────────────────────────────────────────────────

func (r *SectionRepo) scanSeats(ctx context.Context, q string, arg any) ([]*repository.Seat, error) {
	rows, err := r.pool.Query(ctx, q, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var seats []*repository.Seat
	for rows.Next() {
		s := &repository.Seat{}
		var priceTierID sql.NullString
		if err := rows.Scan(
			&s.ID, &s.SectionID, &s.PlanID, &priceTierID,
			&s.SeatLabel, &s.RowLabel, &s.ColumnNumber,
			&s.Status, &s.HeldBy, &s.HeldUntil,
			&s.Attributes, &s.Version,
			&s.CreatedAt, &s.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if priceTierID.Valid {
			s.PriceTierID = priceTierID.String
		} else {
			s.PriceTierID = ""
		}
		seats = append(seats, s)
	}
	return seats, rows.Err()
}
