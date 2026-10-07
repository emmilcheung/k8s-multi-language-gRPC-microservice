// Package backfill gives every venue that existed before organizer accounts an
// owning account. It is safe to run any number of times: a venue is only
// picked up while its created_by_account_id is empty, so a run resumes where
// the last one stopped and a finished one has nothing to do.
package backfill

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Accounts is the part of user-service the backfill needs. Both calls are
// idempotent on the user-service side.
type Accounts interface {
	// EnsurePersonalAccount returns the user's personal organizer account,
	// creating it on first call.
	EnsurePersonalAccount(ctx context.Context, userID string) (accountID string, err error)
	// EnsureVenueManager makes the user a venue manager of the venue.
	EnsureVenueManager(ctx context.Context, userID, venueID string) error
}

// Options tune a run.
type Options struct {
	// BatchSize is how many venues one round handles. Must be positive.
	BatchSize int
	// Throttle is the pause between rounds, to keep load off the database
	// and user-service.
	Throttle time.Duration
	// DryRun counts what would be done and changes nothing.
	DryRun bool
	Log    *zap.Logger
	// OnProgress is called after every round with the running totals.
	OnProgress func(Result)
}

// Result counts the work of one run. In a dry run it counts the work pending.
type Result struct {
	Venues int
	Owners int
}

// Run backfills venues in batches until none are left.
func Run(ctx context.Context, pool *pgxpool.Pool, accounts Accounts, opts Options) (Result, error) {
	if opts.BatchSize <= 0 {
		return Result{}, fmt.Errorf("backfill: batch size must be positive, got %d", opts.BatchSize)
	}
	if opts.DryRun {
		return count(ctx, pool)
	}

	var res Result
	accountOf := map[string]string{}
	for {
		batch, err := nextBatch(ctx, pool, opts.BatchSize)
		if err != nil {
			return res, err
		}
		if len(batch) == 0 {
			return res, nil
		}
		for _, v := range batch {
			accountID, seen := accountOf[v.ownerID]
			if !seen {
				if accountID, err = accounts.EnsurePersonalAccount(ctx, v.ownerID); err != nil {
					return res, fmt.Errorf("backfill: personal account for owner of venue %s: %w", v.id, err)
				}
				accountOf[v.ownerID] = accountID
				res.Owners++
			}
			if err := accounts.EnsureVenueManager(ctx, v.ownerID, v.id); err != nil {
				return res, fmt.Errorf("backfill: venue manager for venue %s: %w", v.id, err)
			}
			if _, err := pool.Exec(ctx,
				`UPDATE venues SET created_by_account_id = $1 WHERE id = $2 AND created_by_account_id IS NULL`,
				accountID, v.id); err != nil {
				return res, fmt.Errorf("backfill: set owning account of venue %s: %w", v.id, err)
			}
			res.Venues++
		}
		if opts.Log != nil {
			opts.Log.Info("venue ownership backfill progress", zap.Int("venues_done", res.Venues), zap.Int("owners_done", res.Owners))
		}
		if opts.OnProgress != nil {
			opts.OnProgress(res)
		}
		if err := sleep(ctx, opts.Throttle); err != nil {
			return res, err
		}
	}
}

type venue struct{ id, ownerID string }

func nextBatch(ctx context.Context, pool *pgxpool.Pool, limit int) ([]venue, error) {
	rows, err := pool.Query(ctx,
		`SELECT id::text, organizer_id::text FROM venues WHERE created_by_account_id IS NULL ORDER BY id LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("backfill: read next batch: %w", err)
	}
	defer rows.Close()
	var out []venue
	for rows.Next() {
		var v venue
		if err := rows.Scan(&v.id, &v.ownerID); err != nil {
			return nil, fmt.Errorf("backfill: scan venue: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func count(ctx context.Context, pool *pgxpool.Pool) (Result, error) {
	var res Result
	err := pool.QueryRow(ctx,
		`SELECT count(*), count(DISTINCT organizer_id) FROM venues WHERE created_by_account_id IS NULL`).
		Scan(&res.Venues, &res.Owners)
	if err != nil {
		return res, fmt.Errorf("backfill: count pending venues: %w", err)
	}
	return res, nil
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
