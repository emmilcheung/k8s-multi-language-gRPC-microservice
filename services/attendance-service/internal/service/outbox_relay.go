package service

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"go.uber.org/zap"
)

// OutboxRelay publishes queued outbox rows and marks them as published.
// WS2 runs this as a single process-local relay per deployment; it does not
// coordinate row claiming across multiple replicas.
type OutboxRelay struct {
	repo repository.OutboxRepository
	pub  EventPublisher
	log  *zap.Logger
}

func NewOutboxRelay(repo repository.OutboxRepository, pub EventPublisher, log *zap.Logger) *OutboxRelay {
	return &OutboxRelay{repo: repo, pub: pub, log: log}
}

func (r *OutboxRelay) Run(ctx context.Context, interval time.Duration, batchSize int) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		if err := r.RunOnce(ctx, batchSize); err != nil {
			r.log.Error("attendance outbox relay iteration failed", zap.Error(err))
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *OutboxRelay) RunOnce(ctx context.Context, batchSize int) error {
	rows, err := r.repo.ListUnpublished(ctx, batchSize)
	if err != nil {
		return fmt.Errorf("list unpublished outbox rows: %w", err)
	}
	for _, row := range rows {
		if err := r.pub.Publish(row.Topic, []byte(row.PartitionKey), row.Payload); err != nil {
			return fmt.Errorf("publish outbox row %s: %w", row.ID, err)
		}
		publishedAt := time.Now().UTC()
		if err := r.repo.MarkPublished(ctx, row.ID, publishedAt); err != nil {
			return fmt.Errorf("mark outbox row %s published: %w", row.ID, err)
		}
	}
	return nil
}
