package postgres

import (
	"context"
	"errors"

	"github.com/acme/venue-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// VenueSectionRepo implements repository.VenueSectionRepository using PostgreSQL.
type VenueSectionRepo struct {
	pool *pgxpool.Pool
}

// NewVenueSectionRepo creates a new VenueSectionRepo.
func NewVenueSectionRepo(pool *pgxpool.Pool) *VenueSectionRepo {
	return &VenueSectionRepo{pool: pool}
}

// Create inserts a new venue section template row.
func (r *VenueSectionRepo) Create(ctx context.Context, vs *repository.VenueSection) error {
	const q = `
		INSERT INTO venue_sections (venue_id, name, type, row_count, column_count, position_json, display_order)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
		RETURNING id, created_at, updated_at`

	posJSON := vs.PositionJSON
	if posJSON == "" {
		posJSON = "{}"
	}

	return r.pool.QueryRow(ctx, q,
		vs.VenueID, vs.Name, string(vs.Type), vs.RowCount, vs.ColumnCount,
		posJSON, vs.DisplayOrder,
	).Scan(&vs.ID, &vs.CreatedAt, &vs.UpdatedAt)
}

// FindByID fetches a venue section by primary key.
func (r *VenueSectionRepo) FindByID(ctx context.Context, id string) (*repository.VenueSection, error) {
	const q = `
		SELECT id, venue_id, name, type, row_count, column_count,
		       position_json::text, display_order, created_at, updated_at
		FROM   venue_sections
		WHERE  id = $1`

	vs := &repository.VenueSection{}
	err := r.pool.QueryRow(ctx, q, id).Scan(
		&vs.ID, &vs.VenueID, &vs.Name, &vs.Type,
		&vs.RowCount, &vs.ColumnCount, &vs.PositionJSON,
		&vs.DisplayOrder, &vs.CreatedAt, &vs.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrSectionNotFound
		}
		return nil, err
	}
	return vs, nil
}

// ListByVenue returns all template sections for a venue, ordered by display_order.
func (r *VenueSectionRepo) ListByVenue(ctx context.Context, venueID string) ([]*repository.VenueSection, error) {
	const q = `
		SELECT id, venue_id, name, type, row_count, column_count,
		       position_json::text, display_order, created_at, updated_at
		FROM   venue_sections
		WHERE  venue_id = $1
		ORDER  BY display_order, created_at`

	rows, err := r.pool.Query(ctx, q, venueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*repository.VenueSection
	for rows.Next() {
		vs := &repository.VenueSection{}
		if err := rows.Scan(
			&vs.ID, &vs.VenueID, &vs.Name, &vs.Type,
			&vs.RowCount, &vs.ColumnCount, &vs.PositionJSON,
			&vs.DisplayOrder, &vs.CreatedAt, &vs.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, vs)
	}
	return out, rows.Err()
}

// Update patches mutable fields of a venue section.
func (r *VenueSectionRepo) Update(ctx context.Context, vs *repository.VenueSection) error {
	const q = `
		UPDATE venue_sections
		SET    name = $1, type = $2, row_count = $3, column_count = $4,
		       position_json = $5::jsonb, display_order = $6, updated_at = now()
		WHERE  id = $7 AND venue_id = $8
		RETURNING updated_at`

	posJSON := vs.PositionJSON
	if posJSON == "" {
		posJSON = "{}"
	}

	err := r.pool.QueryRow(ctx, q,
		vs.Name, string(vs.Type), vs.RowCount, vs.ColumnCount,
		posJSON, vs.DisplayOrder, vs.ID, vs.VenueID,
	).Scan(&vs.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return repository.ErrSectionNotFound
		}
		return err
	}
	return nil
}

// Delete removes a venue section template row.
// venueID is used as an ownership guard.
func (r *VenueSectionRepo) Delete(ctx context.Context, id, venueID string) error {
	const q = `DELETE FROM venue_sections WHERE id = $1 AND venue_id = $2`
	tag, err := r.pool.Exec(ctx, q, id, venueID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return repository.ErrSectionNotFound
	}
	return nil
}
