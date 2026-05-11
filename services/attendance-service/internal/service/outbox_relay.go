package service

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// TxBeginner is satisfied by *pgxpool.Pool and by test doubles.
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// OutboxRelay publishes queued outbox rows and marks them as published.
// Each RunOnce call opens a single transaction and claims rows with
// FOR UPDATE SKIP LOCKED so that concurrent relay replicas (HPA scale-out)
// each receive disjoint sets of rows and never double-publish.
type OutboxRelay struct {
	db   TxBeginner
	repo repository.OutboxRepository
	pub  EventPublisher
	log  *zap.Logger
}

func NewOutboxRelay(db TxBeginner, repo repository.OutboxRepository, pub EventPublisher, log *zap.Logger) *OutboxRelay {
	return &OutboxRelay{db: db, repo: repo, pub: pub, log: log}
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
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("relay: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := r.repo.ListUnpublishedTx(ctx, tx, batchSize)
	if err != nil {
		return fmt.Errorf("relay: list unpublished outbox rows: %w", err)
	}
	for _, row := range rows {
		if err := r.pub.Publish(row.Topic, []byte(row.PartitionKey), row.Payload); err != nil {
			r.log.Warn("relay: publish failed; releasing claim",
				zap.String("id", row.ID), zap.Error(err))
			return fmt.Errorf("relay: publish outbox row %s: %w", row.ID, err)
		}
		if err := r.repo.MarkPublishedTx(ctx, tx, row.ID, time.Now().UTC()); err != nil {
			return fmt.Errorf("relay: mark outbox row %s published: %w", row.ID, err)
		}
	}
	return tx.Commit(ctx)
}
