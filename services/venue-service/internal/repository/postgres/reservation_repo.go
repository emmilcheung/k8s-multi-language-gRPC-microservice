package postgres

import (
	"context"
	"errors"

	"github.com/acme/venue-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ReservationRepo implements repository.ReservationRepository using pgxpool.
type ReservationRepo struct {
	pool *pgxpool.Pool
}

// NewReservationRepo creates a new ReservationRepo backed by the given pool.
func NewReservationRepo(pool *pgxpool.Pool) *ReservationRepo {
	return &ReservationRepo{pool: pool}
}

// CreateReservation writes the reservation header and items atomically.
// On return, r.ID, r.CreatedAt, r.UpdatedAt are populated (if not already set by caller).
func (r *ReservationRepo) CreateReservation(ctx context.Context, res *repository.SeatReservation) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	const hq = `
		INSERT INTO seat_reservations
		            (plan_id, ticket_id, user_id, section_id, status, expires_at)
		VALUES      ($1, $2, $3, $4, $5, $6)
		RETURNING   id, created_at, updated_at`

	err = tx.QueryRow(ctx, hq,
		res.PlanID, res.TicketID, res.UserID,
		nullStr(res.SectionID), string(res.Status), res.ExpiresAt,
	).Scan(&res.ID, &res.CreatedAt, &res.UpdatedAt)
	if err != nil {
		return err
	}

	for i := range res.Items {
		item := &res.Items[i]
		item.ReservationID = res.ID
		const iq = `
			INSERT INTO seat_reservation_items (reservation_id, seat_id, section_id, price, seat_label)
			VALUES ($1, $2, $3, $4::numeric, $5)`
		if _, err := tx.Exec(ctx, iq,
			item.ReservationID, item.SeatID, item.SectionID, item.Price, item.SeatLabel,
		); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// FindReservationByID returns a reservation with its items by primary key.
func (r *ReservationRepo) FindReservationByID(ctx context.Context, id string) (*repository.SeatReservation, error) {
	const hq = `
		SELECT id, plan_id, ticket_id,
		       COALESCE(order_id::text,''),
		       user_id,
		       COALESCE(section_id::text,''),
		       status, expires_at, created_at, updated_at
		FROM seat_reservations WHERE id = $1`

	res := &repository.SeatReservation{}
	err := r.pool.QueryRow(ctx, hq, id).Scan(
		&res.ID, &res.PlanID, &res.TicketID,
		&res.OrderID, &res.UserID, &res.SectionID,
		&res.Status, &res.ExpiresAt, &res.CreatedAt, &res.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrReservationNotFound
		}
		return nil, err
	}

	const iq = `
		SELECT reservation_id, seat_id, section_id, price::text, seat_label
		FROM seat_reservation_items WHERE reservation_id = $1`
	rows, err := r.pool.Query(ctx, iq, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		item := repository.SeatReservationItem{}
		if err := rows.Scan(&item.ReservationID, &item.SeatID, &item.SectionID, &item.Price, &item.SeatLabel); err != nil {
			return nil, err
		}
		res.Items = append(res.Items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return res, nil
}

// ReleaseReservation transitions RESERVED → RELEASED and restores seats to AVAILABLE.
// Idempotent: RELEASED reservations return success.
// Returns ErrReservationConflict if already SOLD.
func (r *ReservationRepo) ReleaseReservation(ctx context.Context, reservationID, reason string) error {
	res, err := r.FindReservationByID(ctx, reservationID)
	if err != nil {
		return err
	}

	switch res.Status {
	case repository.ReservationStatusReleased:
		return repository.ErrReservationAlreadyDone
	case repository.ReservationStatusSold:
		return repository.ErrReservationConflict
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Release seats.
	seatIDs := make([]string, len(res.Items))
	for i, item := range res.Items {
		seatIDs[i] = item.SeatID
	}
	if len(seatIDs) > 0 {
		const seatQ = `
			UPDATE seats
			SET status = 'AVAILABLE', held_by = NULL, held_until = NULL,
			    version = version + 1, updated_at = now()
			WHERE id = ANY($1) AND status = 'RESERVED'`
		if _, err := tx.Exec(ctx, seatQ, seatIDs); err != nil {
			return err
		}
	}

	// Update reservation status.
	const resQ = `
		UPDATE seat_reservations SET status = 'RELEASED', updated_at = now()
		WHERE id = $1`
	if _, err := tx.Exec(ctx, resQ, reservationID); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// FinalizeReservation transitions RESERVED → SOLD and records the orderId.
// Idempotent: SOLD reservations return success.
// Returns ErrReservationConflict if RELEASED.
func (r *ReservationRepo) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	res, err := r.FindReservationByID(ctx, reservationID)
	if err != nil {
		return err
	}

	switch res.Status {
	case repository.ReservationStatusSold:
		return repository.ErrReservationAlreadyDone
	case repository.ReservationStatusReleased:
		return repository.ErrReservationConflict
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Sell seats.
	seatIDs := make([]string, len(res.Items))
	for i, item := range res.Items {
		seatIDs[i] = item.SeatID
	}
	if len(seatIDs) > 0 {
		const seatQ = `
			UPDATE seats
			SET status = 'SOLD', version = version + 1, updated_at = now()
			WHERE id = ANY($1) AND status = 'RESERVED'`
		if _, err := tx.Exec(ctx, seatQ, seatIDs); err != nil {
			return err
		}
	}

	// Finalize reservation.
	const resQ = `
		UPDATE seat_reservations
		SET status = 'SOLD', order_id = $1, updated_at = now()
		WHERE id = $2`
	if _, err := tx.Exec(ctx, resQ, orderID, reservationID); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// ── helpers ───────────────────────────────────────────────────────────────────

// AtomicReserveAndCreate locks the requested seats, transitions them from
// HELD/AVAILABLE → RESERVED, and writes the reservation header + items in a
// single PostgreSQL transaction.
//
// r.ID must be pre-populated by the caller (the reservationId from the gRPC
// request).  r.Items is populated with snapshotted seat data on success.
//
// ticketBasePrice is the ticket's base price (decimal string, e.g. "25.50").
// It is used as the final COALESCE fallback if no seat or section price tier is assigned.
func (r *ReservationRepo) AtomicReserveAndCreate(ctx context.Context, seatIDs []string, res *repository.SeatReservation, ticketBasePrice string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// 1. Lock seats and fetch status + snapshotted price in one pass.
	//    FOR UPDATE OF s prevents concurrent reservations for the same seats.
	//    Price resolution: seat tier > section tier > ticket base price.
	const lockQ = `
		SELECT s.id,
		       s.section_id,
		       s.seat_label,
		       s.status,
		       COALESCE(seat_pt.price::text, section_pt.price::text, $2) AS price
		FROM   seats s
		LEFT JOIN price_tiers seat_pt ON seat_pt.id = s.price_tier_id
		LEFT JOIN sections sec ON sec.id = s.section_id
		LEFT JOIN price_tiers section_pt ON section_pt.id = sec.price_tier_id
		WHERE  s.id = ANY($1)
		FOR UPDATE OF s`

	type seatRow struct {
		id        string
		sectionID string
		seatLabel string
		status    string
		price     string
	}

	rows, err := tx.Query(ctx, lockQ, seatIDs, ticketBasePrice)
	if err != nil {
		return err
	}
	locked := make(map[string]seatRow, len(seatIDs))
	for rows.Next() {
		var sr seatRow
		if err := rows.Scan(&sr.id, &sr.sectionID, &sr.seatLabel, &sr.status, &sr.price); err != nil {
			rows.Close()
			return err
		}
		locked[sr.id] = sr
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// 2. Validate all requested seats exist and are in a reservable state.
	for _, id := range seatIDs {
		sr, ok := locked[id]
		if !ok {
			return repository.ErrSeatNotAvailable
		}
		if sr.status != string(repository.SeatStatusHeld) && sr.status != string(repository.SeatStatusAvailable) {
			return repository.ErrSeatNotAvailable
		}
	}

	// 3. Transition seats → RESERVED.  Store reservationId as held_by so the
	//    seats can be easily traced back to the ledger without extra lookups.
	const updateQ = `
		UPDATE seats
		SET    status     = 'RESERVED',
		       held_by    = $1,
		       held_until = NULL,
		       version    = version + 1,
		       updated_at = now()
		WHERE  id = ANY($2)`
	if _, err := tx.Exec(ctx, updateQ, res.ID, seatIDs); err != nil {
		return err
	}

	// 4. Insert the reservation header with the caller-supplied ID.
	const hq = `
		INSERT INTO seat_reservations
		            (id, plan_id, ticket_id, user_id, section_id, status, expires_at)
		VALUES      ($1, $2, $3, $4, $5, $6, $7)
		RETURNING   created_at, updated_at`
	err = tx.QueryRow(ctx, hq,
		res.ID, res.PlanID, res.TicketID, res.UserID,
		nullStr(res.SectionID), string(res.Status), res.ExpiresAt,
	).Scan(&res.CreatedAt, &res.UpdatedAt)
	if err != nil {
		// Unique constraint violation means this reservationId was already committed
		// (race between two concurrent identical requests).
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return repository.ErrReservationAlreadyDone
		}
		return err
	}

	// 5. Insert reservation items with snapshotted prices.
	res.Items = make([]repository.SeatReservationItem, 0, len(seatIDs))
	for _, id := range seatIDs {
		sr := locked[id]
		item := repository.SeatReservationItem{
			ReservationID: res.ID,
			SeatID:        sr.id,
			SectionID:     sr.sectionID,
			Price:         sr.price,
			SeatLabel:     sr.seatLabel,
		}
		const iq = `
			INSERT INTO seat_reservation_items (reservation_id, seat_id, section_id, price, seat_label)
			VALUES ($1, $2, $3, $4::numeric, $5)`
		if _, err := tx.Exec(ctx, iq,
			item.ReservationID, item.SeatID, item.SectionID, item.Price, item.SeatLabel,
		); err != nil {
			return err
		}
		res.Items = append(res.Items, item)
	}

	return tx.Commit(ctx)
}

// nullStr returns nil if s is empty, otherwise returns &s.
// Used to map empty-string sentinel to SQL NULL.
func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
