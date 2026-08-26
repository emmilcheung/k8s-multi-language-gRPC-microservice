package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func newOutboxRow(id string, published bool, createdAt time.Time) *repository.OutboxRow {
	return &repository.OutboxRow{
		ID:           id,
		Topic:        "attendance.qr.issued",
		PartitionKey: id,
		Published:    published,
		CreatedAt:    createdAt,
	}
}

// Retention exists so the outbox table does not grow for the life of the
// deployment. What must never happen is a purge that removes rows the relay
// still has to publish — those are the events themselves, and dropping one
// loses it permanently.
func TestOutboxCleanupRunOnce_ShouldDeleteOnlyPublishedRowsPastRetention(t *testing.T) {
	now := time.Now().UTC()
	repo := &credRepoDouble{
		outboxByID: map[string]*repository.OutboxRow{
			"old-published":   newOutboxRow("old-published", true, now.Add(-48*time.Hour)),
			"old-unpublished": newOutboxRow("old-unpublished", false, now.Add(-48*time.Hour)),
			"new-published":   newOutboxRow("new-published", true, now.Add(-time.Hour)),
			"new-unpublished": newOutboxRow("new-unpublished", false, now.Add(-time.Hour)),
		},
	}

	cleanup := NewOutboxCleanup(repo, zap.NewNop())
	require.NoError(t, cleanup.RunOnce(context.Background(), OutboxRetention))

	remaining := make([]string, 0, len(repo.outboxByID))
	for id := range repo.outboxByID {
		remaining = append(remaining, id)
	}
	assert.NotContains(t, remaining, "old-published", "published rows past retention should be purged")
	assert.Contains(t, remaining, "old-unpublished", "unpublished rows must never be purged — the event would be lost")
	assert.Contains(t, remaining, "new-published", "published rows inside the retention window are kept for replay")
	assert.Contains(t, remaining, "new-unpublished")
}

// A purge that cannot make progress must surface as an error to the caller (which
// logs at WARN and retries next tick) rather than being swallowed.
func TestOutboxCleanupRunOnce_ShouldReturnError_WhenDeleteFails(t *testing.T) {
	repo := &credRepoDouble{
		outboxByID:         map[string]*repository.OutboxRow{},
		deletePublishedErr: errors.New("deadlock detected"),
	}

	cleanup := NewOutboxCleanup(repo, zap.NewNop())
	err := cleanup.RunOnce(context.Background(), OutboxRetention)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "deadlock detected")
}

// The purge must stop once a batch comes back short, otherwise every cycle would
// issue outboxCleanupMaxBatches statements even with nothing left to delete.
func TestOutboxCleanupRunOnce_ShouldStopOnce_BatchComesBackShort(t *testing.T) {
	repo := &countingOutboxRepo{rows: 1} // one purgeable row: the first batch returns short

	cleanup := NewOutboxCleanup(repo, zap.NewNop())
	require.NoError(t, cleanup.RunOnce(context.Background(), OutboxRetention))

	assert.Equal(t, 1, repo.calls, "a short batch means the backlog is drained; stop issuing statements")
}

// countingOutboxRepo counts DeletePublishedBefore calls and drains `rows`.
type countingOutboxRepo struct {
	repository.OutboxRepository
	rows  int
	calls int
}

func (c *countingOutboxRepo) DeletePublishedBefore(_ context.Context, _ time.Time, limit int) (int64, error) {
	c.calls++
	n := c.rows
	if n > limit {
		n = limit
	}
	c.rows -= n
	return int64(n), nil
}
