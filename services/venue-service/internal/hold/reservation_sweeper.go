package hold

import (
	"context"
	"time"

	"go.uber.org/zap"
)

// ReservationExpirer expires overdue RESERVED seat reservations and restores
// their seats. Implemented by postgres.ReservationRepo.
type ReservationExpirer interface {
	SweepExpiredReservations(ctx context.Context) (int64, error)
}

// ReservationSweeper periodically reclaims RESERVED reservations whose
// expires_at has passed. It is the venue-side counterpart of ticket-service's
// quota reconciler: it reclaims seats when no order exists to release them
// (order-service does not compensate keyed creates and relies on expiry).
type ReservationSweeper struct {
	repo     ReservationExpirer
	interval time.Duration
	log      *zap.Logger
}

// NewReservationSweeper creates a ReservationSweeper that runs every interval.
func NewReservationSweeper(repo ReservationExpirer, interval time.Duration, log *zap.Logger) *ReservationSweeper {
	return &ReservationSweeper{repo: repo, interval: interval, log: log}
}

// Start begins the sweep loop. It returns when ctx is cancelled.
func (s *ReservationSweeper) Start(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	s.log.Info("reservation sweeper started", zap.Duration("interval", s.interval))

	for {
		select {
		case <-ctx.Done():
			s.log.Info("reservation sweeper stopped")
			return
		case <-ticker.C:
			n, err := s.repo.SweepExpiredReservations(ctx)
			if err != nil {
				s.log.Warn("reservation sweep failed", zap.Error(err))
				continue
			}
			if n > 0 {
				s.log.Info("reservation sweep expired reservations", zap.Int64("count", n))
			}
		}
	}
}
