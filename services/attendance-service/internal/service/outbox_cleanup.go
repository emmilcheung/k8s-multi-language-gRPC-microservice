package service

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"go.uber.org/zap"
)

const (
	// OutboxRetention is how long published outbox rows are kept before purging.
	// Matches order-service's OutboxCleanupJob so the Postgres-backed outboxes
	// across the platform share one retention policy.
	OutboxRetention = 24 * time.Hour
	// OutboxCleanupInterval is how often the purge runs.
	OutboxCleanupInterval = 10 * time.Minute
	// outboxCleanupBatchSize bounds rows deleted per statement.
	outboxCleanupBatchSize = 500
	// outboxCleanupMaxBatches bounds statements per cycle so one purge run
	// cannot monopolise the connection pool while draining a large backlog.
	outboxCleanupMaxBatches = 20
)

// OutboxCleanup periodically deletes published outbox rows past the retention
// window.  Rows that have been published to Kafka are not needed again for
// at-least-once delivery, so without this the outbox table grows unboundedly.
type OutboxCleanup struct {
	repo repository.OutboxRepository
	log  *zap.Logger
}

func NewOutboxCleanup(repo repository.OutboxRepository, log *zap.Logger) *OutboxCleanup {
	return &OutboxCleanup{repo: repo, log: log}
}

// Run purges on interval until ctx is cancelled.
func (c *OutboxCleanup) Run(ctx context.Context, interval, retention time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		if err := c.RunOnce(ctx, retention); err != nil {
			// WARN, not ERROR: the outbox is still fully functional; the purge
			// simply did not reclaim space this cycle and runs again next tick.
			c.log.Warn("attendance outbox cleanup failed", zap.Error(err))
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RunOnce deletes published rows older than retention, in bounded batches.
func (c *OutboxCleanup) RunOnce(ctx context.Context, retention time.Duration) error {
	cutoff := time.Now().UTC().Add(-retention)

	var total int64
	for batch := 0; batch < outboxCleanupMaxBatches; batch++ {
		deleted, err := c.repo.DeletePublishedBefore(ctx, cutoff, outboxCleanupBatchSize)
		if err != nil {
			return fmt.Errorf("cleanup: delete published outbox rows: %w", err)
		}
		total += deleted
		if deleted < outboxCleanupBatchSize {
			break
		}
	}

	if total > 0 {
		c.log.Info("attendance outbox cleanup deleted published rows",
			zap.Int64("deleted", total),
			zap.Duration("retention", retention),
		)
	}
	return nil
}
