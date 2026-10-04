package hold

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"go.uber.org/zap"
)

// Redis seat states, matching the reconciler's encoding.
const (
	redisStateAvailable = "0"
	redisStateReserved  = "2"
	redisStateSold      = "3"
)

// RedisSyncedReservations keeps the Redis seat-state hash in step with
// reservation changes committed to PostgreSQL. PostgreSQL stays the source of
// truth: a Redis write that fails is logged and left for the reconciler, never
// returned to the caller.
//
// Without it a reserved seat still looks "held" in Redis, so a cancelled
// order's seats stay blocked until the old hold's timer runs out, and a sold
// seat stops being blocked in Redis once that timer has run out.
type RedisSyncedReservations struct {
	repository.ReservationRepository
	mgr *Manager
}

// NewRedisSyncedReservations wraps inner so that reserve, release and finalize
// also update the Manager's Redis seat state.
func NewRedisSyncedReservations(inner repository.ReservationRepository, mgr *Manager) *RedisSyncedReservations {
	return &RedisSyncedReservations{ReservationRepository: inner, mgr: mgr}
}

// AtomicReserveAndCreate marks the seats reserved in Redis until the
// reservation expires, so lapsed reservations become free lazily, like holds.
func (r *RedisSyncedReservations) AtomicReserveAndCreate(ctx context.Context, seatIDs []string, res *repository.SeatReservation, ticketBasePrice string, maxPerUser int) error {
	if err := r.ReservationRepository.AtomicReserveAndCreate(ctx, seatIDs, res, ticketBasePrice, maxPerUser); err != nil {
		return err
	}
	r.mgr.markReserved(ctx, res.PlanID, res.ID, seatIDs, res.ExpiresAt)
	return nil
}

// ReleaseReservation frees the seats in Redis, but only when this call is the
// one that moved the reservation out of RESERVED. A redelivered release must
// not wipe a newer hold on the same seats.
func (r *RedisSyncedReservations) ReleaseReservation(ctx context.Context, reservationID, reason string) error {
	before, findErr := r.FindReservationByID(ctx, reservationID)
	if err := r.ReservationRepository.ReleaseReservation(ctx, reservationID, reason); err != nil {
		return err
	}
	if findErr == nil && before.Status == repository.ReservationStatusReserved {
		r.mgr.setSeatState(ctx, before.PlanID, itemSeatIDs(before), redisStateAvailable)
	}
	return nil
}

// FinalizeReservation marks the seats sold in Redis.
func (r *RedisSyncedReservations) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	if err := r.ReservationRepository.FinalizeReservation(ctx, reservationID, orderID); err != nil {
		return err
	}
	res, err := r.FindReservationByID(ctx, reservationID)
	if err != nil {
		r.mgr.log.Warn("could not load finalized reservation to sync redis", zap.Error(err),
			zap.String("reservationId", reservationID))
		return nil
	}
	r.mgr.setSeatState(ctx, res.PlanID, itemSeatIDs(res), redisStateSold)
	return nil
}

func itemSeatIDs(res *repository.SeatReservation) []string {
	ids := make([]string, len(res.Items))
	for i, it := range res.Items {
		ids[i] = it.SeatID
	}
	return ids
}

// markReserved sets seats to reserved, with a marker key that expires with the
// reservation. A reservation without an expiry blocks until released.
func (m *Manager) markReserved(ctx context.Context, planID, reservationID string, seatIDs []string, expiresAt *time.Time) {
	if m.redis == nil || len(seatIDs) == 0 {
		return
	}
	var ttl time.Duration
	if expiresAt != nil {
		ttl = time.Until(*expiresAt)
		if ttl <= 0 {
			// Already lapsed: leave the seats to the free-on-expiry rule.
			return
		}
	}
	meta := fmt.Sprintf(`{"reservationId":%q}`, reservationID)
	pipe := m.redis.TxPipeline()
	for _, id := range seatIDs {
		pipe.HSet(ctx, seatsHashKey(planID), id, redisStateReserved)
		pipe.Set(ctx, holdMetaKey(planID, id), meta, ttl)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		m.log.Warn("failed to mark seats reserved in redis", zap.Error(err), zap.String("planId", planID))
	}
}

// setSeatState sets seats to a state that needs no marker key (available or sold).
func (m *Manager) setSeatState(ctx context.Context, planID string, seatIDs []string, state string) {
	if m.redis == nil || len(seatIDs) == 0 {
		return
	}
	pipe := m.redis.TxPipeline()
	for _, id := range seatIDs {
		pipe.HSet(ctx, seatsHashKey(planID), id, state)
		pipe.Del(ctx, holdMetaKey(planID, id))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		m.log.Warn("failed to sync seat state to redis", zap.Error(err),
			zap.String("planId", planID), zap.String("state", state))
	}
}
