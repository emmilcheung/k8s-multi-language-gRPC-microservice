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
	// At-least-once semantics. Rows are claimed inside a transaction with
	// FOR UPDATE SKIP LOCKED (via ListUnpublishedTx); the claim is held for the
	// whole batch, which is what keeps concurrent replicas disjoint.
	//
	// A publish failure at row N stops the batch but does NOT discard the batch:
	// rows 1..N-1 are already on the topic, so their marks are committed. Rolling
	// them back would re-send every one of them next tick — a guaranteed burst of
	// duplicates on every partial failure, growing with batch position. Row N is
	// left unmarked because we cannot tell whether it reached the broker, so it
	// is retried. Downstream consumers MUST still be idempotent on credential_id.
	//
	// Stopping rather than skipping row N preserves per-entity ordering: skipping
	// would let a later event for the same partition key reach Kafka ahead of an
	// earlier one still being retried.
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("relay: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := r.repo.ListUnpublishedTx(ctx, tx, batchSize)
	if err != nil {
		return fmt.Errorf("relay: list unpublished outbox rows: %w", err)
	}

	var publishErr error
	for _, row := range rows {
		if err := r.pub.Publish(row.Topic, []byte(row.PartitionKey), row.Payload); err != nil {
			r.log.Warn("relay: publish failed; committing progress and retrying this row next tick",
				zap.String("id", row.ID), zap.Error(err))
			publishErr = fmt.Errorf("relay: publish outbox row %s: %w", row.ID, err)
			break
		}
		if err := r.repo.MarkPublishedTx(ctx, tx, row.ID, time.Now().UTC()); err != nil {
			// Unlike a publish failure this aborts the transaction, so there is
			// no progress left to commit — every row in the batch is re-published.
			return fmt.Errorf("relay: mark outbox row %s published: %w", row.ID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("relay: commit outbox batch: %w", err)
	}
	return publishErr
}
