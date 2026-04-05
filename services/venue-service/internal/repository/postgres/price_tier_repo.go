package postgres

import (
	"context"
	"errors"

	"github.com/acme/venue-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PriceTierRepo manages price_tiers rows.
type PriceTierRepo struct {
	pool *pgxpool.Pool
}

// NewPriceTierRepo creates a new PriceTierRepo backed by the given pool.
func NewPriceTierRepo(pool *pgxpool.Pool) *PriceTierRepo {
	return &PriceTierRepo{pool: pool}
}

// Create inserts a new price tier. On return, t.ID and t.CreatedAt are populated.
func (r *PriceTierRepo) Create(ctx context.Context, t *repository.PriceTier) error {
	const q = `
		INSERT INTO price_tiers (plan_id, name, price)
		VALUES ($1, $2, $3::numeric)
		RETURNING id, created_at`
	return r.pool.QueryRow(ctx, q, t.PlanID, t.Name, t.Price).
		Scan(&t.ID, &t.CreatedAt)
}

// FindByID returns a price tier by primary key.
func (r *PriceTierRepo) FindByID(ctx context.Context, id string) (*repository.PriceTier, error) {
	const q = `
		SELECT id, plan_id, name, price::text, created_at
		FROM price_tiers WHERE id = $1`
	t := &repository.PriceTier{}
	err := r.pool.QueryRow(ctx, q, id).Scan(&t.ID, &t.PlanID, &t.Name, &t.Price, &t.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, repository.ErrSectionNotFound // reuse nearest sentinel
		}
		return nil, err
	}
	return t, nil
}

// ListByPlan returns all price tiers for a seating plan.
func (r *PriceTierRepo) ListByPlan(ctx context.Context, planID string) ([]*repository.PriceTier, error) {
	const q = `
		SELECT id, plan_id, name, price::text, created_at
		FROM price_tiers WHERE plan_id = $1
		ORDER BY created_at ASC`
	rows, err := r.pool.Query(ctx, q, planID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tiers []*repository.PriceTier
	for rows.Next() {
		t := &repository.PriceTier{}
		if err := rows.Scan(&t.ID, &t.PlanID, &t.Name, &t.Price, &t.CreatedAt); err != nil {
			return nil, err
		}
		tiers = append(tiers, t)
	}
	return tiers, rows.Err()
}
