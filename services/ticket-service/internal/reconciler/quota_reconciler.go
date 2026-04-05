// Package reconciler provides a background worker that corrects Redis quota
// drift versus MongoDB on a periodic schedule.
//
// On each tick the reconciler performs three operations:
//  1. Expire stale RESERVED reservations whose expiresAt has passed.
//  2. Reseed lost Redis availability keys for GA tickets where the key is absent.
//  3. Force-correct Redis availability keys whose value differs from the
//     authoritative MongoDB value (quota - reserved - sold).
package reconciler

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/acme/ticket-service/internal/cache"
	"github.com/acme/ticket-service/internal/repository"
	"go.uber.org/zap"
)

const (
	// DefaultInterval is the default reconciliation cadence.
	DefaultInterval = 5 * time.Minute

	// pageSize is the number of tickets fetched per FindAll page.
	pageSize = 50
)

// ReservationExpirer is implemented by any type that can sweep stale RESERVED
// reservations. MongoTicketRepository satisfies this interface via its
// SweepExpiredReservations method.
type ReservationExpirer interface {
	SweepExpiredReservations(ctx context.Context) (int, error)
}

// Reconciler is a background worker that corrects Redis quota drift.
type Reconciler struct {
	repo     repository.TicketRepository
	sweeper  ReservationExpirer
	quota    cache.QuotaManager
	interval time.Duration
	log      *zap.Logger
}

// New creates a new Reconciler. interval must be > 0; if zero the
// DefaultInterval is used.
func New(
	repo repository.TicketRepository,
	sweeper ReservationExpirer,
	quota cache.QuotaManager,
	interval time.Duration,
	log *zap.Logger,
) *Reconciler {
	if interval <= 0 {
		interval = DefaultInterval
	}
	return &Reconciler{
		repo:     repo,
		sweeper:  sweeper,
		quota:    quota,
		interval: interval,
		log:      log,
	}
}

// Start blocks until ctx is cancelled, running a full reconciliation pass on
// each tick. The first pass runs after one interval (not immediately) so that
// the service has time to warm up.
func (r *Reconciler) Start(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	r.log.Info("quota reconciler started", zap.Duration("interval", r.interval))
	for {
		select {
		case <-ctx.Done():
			r.log.Info("quota reconciler stopped")
			return
		case <-ticker.C:
			if err := r.Run(ctx); err != nil {
				r.log.Error("quota reconciler run failed", zap.Error(err))
			}
		}
	}
}

// Run executes one full reconciliation pass. It is exported so tests can call
// it directly without the ticker overhead.
//
// The three phases are:
//  1. Sweep expired RESERVED reservations.
//  2. Reseed missing Redis availability keys (force=false).
//  3. Force-correct Redis availability keys that differ from MongoDB truth.
func (r *Reconciler) Run(ctx context.Context) error {
	// ── Phase 1: expire stale reservations ────────────────────────────────────
	expired, sweepErr := r.sweeper.SweepExpiredReservations(ctx)
	if sweepErr != nil {
		r.log.Error("reconciler: sweep expired reservations failed", zap.Error(sweepErr))
		// Non-fatal: continue to quota correction phases.
	} else {
		r.log.Info("reconciler: swept expired reservations", zap.Int("count", expired))
	}

	// ── Phase 2 & 3: paginate tickets and reconcile Redis ─────────────────────
	var cursor string
	for {
		page, err := r.repo.FindAll(ctx, repository.PaginationParams{
			After: cursor,
			Limit: pageSize,
		})
		if err != nil {
			return fmt.Errorf("reconciler: list tickets: %w", err)
		}

		for _, t := range page {
			// Seated tickets bypass the GA quota path; skip them entirely.
			if t.SeatingPlanID != "" {
				continue
			}

			available := t.Quota - t.Reserved - t.Sold
			r.reconcileTicket(ctx, t.ID, available)
		}

		if len(page) < pageSize {
			// Last page — no more tickets.
			break
		}
		last := page[len(page)-1]
		cursor = repository.EncodeCursor(last.CreatedAt, last.ID)
	}

	return nil
}

// reconcileTicket checks the Redis availability for a single ticket and
// reseeds or force-corrects it when needed.
func (r *Reconciler) reconcileTicket(ctx context.Context, ticketID string, available int) {
	redisAvail, err := r.quota.Available(ctx, ticketID)
	if errors.Is(err, cache.ErrKeyNotInitialised) {
		// Phase 2: key absent — reseed without overwriting any surviving key.
		if seedErr := r.quota.Seed(ctx, ticketID, available, false); seedErr != nil {
			r.log.Error("reconciler: reseed missing key failed",
				zap.String("ticketID", ticketID),
				zap.Error(seedErr),
			)
		} else {
			r.log.Info("reconciler: reseeded missing Redis key",
				zap.String("ticketID", ticketID),
				zap.Int("available", available),
			)
		}
		return
	}
	if err != nil {
		r.log.Error("reconciler: read Redis available failed",
			zap.String("ticketID", ticketID),
			zap.Error(err),
		)
		return
	}

	// Phase 3: key exists but value is wrong — force-correct it.
	if redisAvail != available {
		if seedErr := r.quota.Seed(ctx, ticketID, available, true); seedErr != nil {
			r.log.Error("reconciler: force-correct Redis key failed",
				zap.String("ticketID", ticketID),
				zap.Int("redisAvail", redisAvail),
				zap.Int("expected", available),
				zap.Error(seedErr),
			)
		} else {
			r.log.Info("reconciler: force-corrected Redis drift",
				zap.String("ticketID", ticketID),
				zap.Int("was", redisAvail),
				zap.Int("now", available),
			)
		}
	}
}
