// Package hold provides the hold sweeper goroutine.
// The sweeper periodically calls SweepExpiredHolds to release PostgreSQL held
// seats whose hold TTL has elapsed but whose status was never cleaned up
// (e.g. client crashed before explicitly releasing).
package hold

import (
	"context"
	"time"

	"go.uber.org/zap"
)

// Sweeper runs a background goroutine that periodically sweeps expired holds.
type Sweeper struct {
	mgr      *Manager
	interval time.Duration
	log      *zap.Logger
}

// NewSweeper creates a Sweeper that runs every interval.
// A typical interval is 30–60 seconds.
func NewSweeper(mgr *Manager, interval time.Duration, log *zap.Logger) *Sweeper {
	return &Sweeper{mgr: mgr, interval: interval, log: log}
}

// Start begins the sweep loop. It returns when ctx is cancelled.
func (s *Sweeper) Start(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	s.log.Info("hold sweeper started", zap.Duration("interval", s.interval))

	for {
		select {
		case <-ctx.Done():
			s.log.Info("hold sweeper stopped")
			return
		case <-ticker.C:
			n, err := s.mgr.SweepExpiredHolds(ctx)
			if err != nil {
				s.log.Warn("hold sweep failed", zap.Error(err))
				continue
			}
			if n > 0 {
				s.log.Info("hold sweep released expired holds", zap.Int64("count", n))
			}
		}
	}
}
