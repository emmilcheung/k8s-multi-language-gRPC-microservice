// Package postgres provides PostgreSQL-backed repository implementations for venue-service.
package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// VenueRepo implements repository.VenueRepository using pgxpool.
type VenueRepo struct {
	pool *pgxpool.Pool
}

// NewVenueRepo creates a new VenueRepo backed by the given pool.
func NewVenueRepo(pool *pgxpool.Pool) *VenueRepo {
	return &VenueRepo{pool: pool}
}

// Create inserts a new venue row. On return, v.ID, v.CreatedAt, and v.UpdatedAt are populated.
func (r *VenueRepo) Create(ctx context.Context, v *repository.Venue) error {
	const q = `
		INSERT INTO venues (organizer_id, name, capacity, timezone, address)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, address, created_at, updated_at`
	return r.pool.QueryRow(ctx, q, v.OrganizerID, v.Name, v.Capacity, v.Timezone, v.Address).
		Scan(&v.ID, &v.Address, &v.CreatedAt, &v.UpdatedAt)
}

// FindByID returns a venue by primary key.
func (r *VenueRepo) FindByID(ctx context.Context, id string) (*repository.Venue, error) {
	const q = `
		SELECT id, organizer_id, name, capacity, timezone, address, created_at, updated_at
		FROM venues
		WHERE id = $1`
	v := &repository.Venue{}
	err := r.pool.QueryRow(ctx, q, id).
		Scan(&v.ID, &v.OrganizerID, &v.Name, &v.Capacity, &v.Timezone, &v.Address, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrVenueNotFound
		}
		return nil, err
	}
	return v, nil
}

// ListByOrganizer returns all venues owned by the given organizer.
func (r *VenueRepo) ListByOrganizer(ctx context.Context, organizerID string) ([]*repository.Venue, error) {
	const q = `
		SELECT id, organizer_id, name, capacity, timezone, address, created_at, updated_at
		FROM venues
		WHERE organizer_id = $1
		ORDER BY created_at DESC`
	rows, err := r.pool.Query(ctx, q, organizerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var venues []*repository.Venue
	for rows.Next() {
		v := &repository.Venue{}
		if err := rows.Scan(&v.ID, &v.OrganizerID, &v.Name, &v.Capacity, &v.Timezone, &v.Address, &v.CreatedAt, &v.UpdatedAt); err != nil {
			return nil, err
		}
		venues = append(venues, v)
	}
	return venues, rows.Err()
}

// Update persists name, capacity, timezone, and address changes for a venue.
func (r *VenueRepo) Update(ctx context.Context, v *repository.Venue) error {
	const q = `
		UPDATE venues
		SET name = $1, capacity = $2, timezone = $3, address = $4, updated_at = now()
		WHERE id = $5 AND organizer_id = $6
		RETURNING updated_at`
	var updatedAt time.Time
	err := r.pool.QueryRow(ctx, q, v.Name, v.Capacity, v.Timezone, v.Address, v.ID, v.OrganizerID).
		Scan(&updatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return repository.ErrVenueNotFound
		}
		return err
	}
	v.UpdatedAt = updatedAt
	return nil
}

// Ping verifies the database connection is alive.
func (r *VenueRepo) Ping(ctx context.Context) error {
	return r.pool.Ping(ctx)
}
