// Package reconciler provides the Redis↔PostgreSQL seat-state reconciler.
//
// After a Redis restart the venue:{planId}:seats HASH is gone. The reconciler
// detects this condition for every active seating plan and re-seeds the hash
// from the PostgreSQL seats table so that the hot path (hold/release) can
// resume without a cold-start delay.
//
// The reconciler deliberately does NOT overwrite a present hash — the hot path
// keeps Redis authoritative for live operations. The reconciler only fills gaps.
package reconciler

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// SectionLister is the subset of repository.SectionRepository used by the
// reconciler.  Keeping it as a narrow interface makes the reconciler easy to
// test with simple in-memory stubs.
type SectionLister interface {
	ListSectionsByPlan(ctx context.Context, planID string) ([]*repository.Section, error)
	FindSeatsBySection(ctx context.Context, sectionID string) ([]*repository.Seat, error)
}

// Reconciler re-seeds the Redis seat state hash for all active seating plans
// from PostgreSQL when the hash is missing (e.g. after a Redis restart).
//
// It does NOT force-overwrite a present hash — the hot path (hold/release)
// keeps Redis authoritative for live operations. The reconciler only fills gaps.
type Reconciler struct {
	redis       *redis.Client
	planRepo    repository.PlanRepository
	sectionRepo SectionLister
	interval    time.Duration
	log         *zap.Logger
}

// NewReconciler creates a new Reconciler.
//
//   - redisClient must not be nil (callers should guard on cfg.RedisURL != "").
//   - interval controls how often the reconciler polls; 5 minutes is a sensible
//     default for most production workloads.
func NewReconciler(
	redisClient *redis.Client,
	planRepo repository.PlanRepository,
	sectionRepo SectionLister,
	interval time.Duration,
	log *zap.Logger,
) *Reconciler {
	return &Reconciler{
		redis:       redisClient,
		planRepo:    planRepo,
		sectionRepo: sectionRepo,
		interval:    interval,
		log:         log,
	}
}

// Start begins the reconciliation loop. It returns when ctx is cancelled.
// The first pass runs after the initial interval fires, matching the same
// pattern as hold/sweeper.go.
func (r *Reconciler) Start(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	r.log.Info("redis reconciler started", zap.Duration("interval", r.interval))

	for {
		select {
		case <-ctx.Done():
			r.log.Info("redis reconciler stopped")
			return
		case <-ticker.C:
			if err := r.Run(ctx); err != nil {
				r.log.Warn("redis reconcile pass failed", zap.Error(err))
			}
		}
	}
}

// Run performs a single reconciliation pass over all active seating plans.
// For each plan whose seats hash is absent from Redis the full seat state is
// loaded from PostgreSQL and written back to Redis via a pipeline HSET.
func (r *Reconciler) Run(ctx context.Context) error {
	plans, err := r.planRepo.ListActivePlans(ctx)
	if err != nil {
		return fmt.Errorf("reconciler: list active plans: %w", err)
	}

	for _, plan := range plans {
		if err := r.reconcilePlan(ctx, plan.ID); err != nil {
			// Log per-plan errors but continue with remaining plans so a single
			// bad plan does not block reconciliation of all others.
			r.log.Warn("reconciler: failed to reconcile plan",
				zap.String("planId", plan.ID),
				zap.Error(err),
			)
		}
	}
	return nil
}

// reconcilePlan checks whether the seats hash for planID exists in Redis.
// If it does, the plan is skipped (hot path manages it). If it doesn't, the
// full seat state is loaded from PostgreSQL and written to Redis.
func (r *Reconciler) reconcilePlan(ctx context.Context, planID string) error {
	hashKey := seatsHashKey(planID)

	exists, err := r.redis.Exists(ctx, hashKey).Result()
	if err != nil {
		return fmt.Errorf("EXISTS %s: %w", hashKey, err)
	}
	if exists > 0 {
		// Hash is present — the hot path keeps it current, nothing to do.
		return nil
	}

	// Hash is absent: load from PostgreSQL and re-seed.
	sections, err := r.sectionRepo.ListSectionsByPlan(ctx, planID)
	if err != nil {
		return fmt.Errorf("list sections for plan %s: %w", planID, err)
	}

	// Collect all seat fields for a single pipelined HSET.
	fieldVals := make([]interface{}, 0)
	for _, sec := range sections {
		seats, err := r.sectionRepo.FindSeatsBySection(ctx, sec.ID)
		if err != nil {
			return fmt.Errorf("find seats for section %s: %w", sec.ID, err)
		}
		for _, seat := range seats {
			fieldVals = append(fieldVals, seat.ID, seatStateByte(seat.Status))
		}
	}

	if len(fieldVals) == 0 {
		// No seats — nothing to seed.
		return nil
	}

	// Write all fields in a single pipeline round-trip.
	pipe := r.redis.Pipeline()
	pipe.HSet(ctx, hashKey, fieldVals...)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("HSET pipeline for plan %s: %w", planID, err)
	}

	seatCount := len(fieldVals) / 2
	r.log.Info("redis seat hash reseeded",
		zap.String("planId", planID),
		zap.Int("seats", seatCount),
	)
	return nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func seatsHashKey(planID string) string {
	return fmt.Sprintf("venue:{%s}:seats", planID)
}

// seatStateByte maps a SeatStatus to its Redis wire byte.
//
//	"0" AVAILABLE
//	"1" HELD
//	"2" RESERVED
//	"3" SOLD
//	"4" BLOCKED
func seatStateByte(s repository.SeatStatus) string {
	switch s {
	case repository.SeatStatusAvailable:
		return "0"
	case repository.SeatStatusHeld:
		return "1"
	case repository.SeatStatusReserved:
		return "2"
	case repository.SeatStatusSold:
		return "3"
	case repository.SeatStatusBlocked:
		return "4"
	default:
		return "0"
	}
}
