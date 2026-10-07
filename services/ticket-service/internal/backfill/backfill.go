// Package backfill gives every ticket that existed before organizer accounts
// an owning account: the personal account of the user who created it. It is
// safe to run any number of times. A ticket is only touched while it has no
// account, so a run resumes where the last one stopped and a finished one has
// nothing to do. Tickets created after a run are picked up by the next run.
package backfill

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// Accounts is the part of user-service the backfill needs. The call is
// idempotent on the user-service side.
type Accounts interface {
	// EnsurePersonalAccount returns the user's personal organizer account,
	// creating it on first call.
	EnsurePersonalAccount(ctx context.Context, userID string) (accountID string, err error)
}

// Store is the ticket data the backfill reads and writes.
type Store interface {
	PendingOwners(ctx context.Context, limit int) ([]string, error)
	CountPending(ctx context.Context) (tickets, owners int, err error)
	SetAccountForOwner(ctx context.Context, userID, accountID string) (int64, error)
}

// Options tune a run.
type Options struct {
	// BatchSize is how many owners one round handles. Must be positive.
	BatchSize int
	// Throttle is the pause between rounds, to keep load off MongoDB and user-service.
	Throttle time.Duration
	// DryRun counts what would be done and changes nothing.
	DryRun bool
	Log    *zap.Logger
	// OnProgress is called after every round with the running totals.
	OnProgress func(Result)
}

// Result counts the work of one run. In a dry run it counts the work pending.
type Result struct {
	Tickets int
	Owners  int
}

// Run backfills tickets owner by owner, in batches of owners, until none are left.
func Run(ctx context.Context, store Store, accounts Accounts, opts Options) (Result, error) {
	if opts.BatchSize <= 0 {
		return Result{}, fmt.Errorf("backfill: batch size must be positive, got %d", opts.BatchSize)
	}
	if opts.DryRun {
		tickets, owners, err := store.CountPending(ctx)
		return Result{Tickets: tickets, Owners: owners}, err
	}

	var res Result
	for {
		owners, err := store.PendingOwners(ctx, opts.BatchSize)
		if err != nil {
			return res, err
		}
		if len(owners) == 0 {
			return res, nil
		}
		for _, owner := range owners {
			accountID, err := accounts.EnsurePersonalAccount(ctx, owner)
			if err != nil {
				return res, fmt.Errorf("backfill: personal account for owner %s: %w", owner, err)
			}
			n, err := store.SetAccountForOwner(ctx, owner, accountID)
			if err != nil {
				return res, err
			}
			res.Tickets += int(n)
			res.Owners++
		}
		if opts.Log != nil {
			opts.Log.Info("ticket ownership backfill progress", zap.Int("tickets_done", res.Tickets), zap.Int("owners_done", res.Owners))
		}
		if opts.OnProgress != nil {
			opts.OnProgress(res)
		}
		if err := sleep(ctx, opts.Throttle); err != nil {
			return res, err
		}
	}
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
