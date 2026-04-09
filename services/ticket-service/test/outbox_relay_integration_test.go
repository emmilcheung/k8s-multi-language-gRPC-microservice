package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClaimPendingOutboxEvents_ShouldLeaseEligibleEvent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	ticket := &repository.Ticket{
		ID:         "ticket-outbox-1",
		Title:      "Concert",
		Price:      "10.00",
		UserID:     "seller-1",
		Quota:      10,
		MaxPerUser: 2,
		PendingOutbox: []repository.TicketOutboxEvent{
			repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketCreated, repository.TicketOutboxPayload{}),
		},
	}
	require.NoError(t, repo.Create(ctx, ticket))

	claimed, err := repo.ClaimPendingOutboxEvents(ctx, 30*time.Second, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, "ticket-outbox-1", claimed[0].TicketID)
	assert.Equal(t, repository.OutboxEventTypeTicketCreated, claimed[0].Event.Type)
	assert.NotEmpty(t, claimed[0].Event.ClaimToken)
	require.NotNil(t, claimed[0].Event.LeaseUntil)

	claimedAgain, err := repo.ClaimPendingOutboxEvents(ctx, 30*time.Second, 1)
	require.NoError(t, err)
	assert.Empty(t, claimedAgain)
}

func TestAcknowledgeOutboxEvent_ShouldRemoveClaimedEvent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	ticket := &repository.Ticket{
		ID:         "ticket-outbox-ack",
		Title:      "Concert",
		Price:      "10.00",
		UserID:     "seller-1",
		Quota:      10,
		MaxPerUser: 2,
		PendingOutbox: []repository.TicketOutboxEvent{
			repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketUpdated, repository.TicketOutboxPayload{}),
		},
	}
	require.NoError(t, repo.Create(ctx, ticket))

	claimed, err := repo.ClaimPendingOutboxEvents(ctx, 30*time.Second, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)

	err = repo.AcknowledgeOutboxEvent(ctx, claimed[0].TicketID, claimed[0].Event.ID, claimed[0].Event.ClaimToken)
	require.NoError(t, err)

	stored, err := repo.FindByID(ctx, claimed[0].TicketID)
	require.NoError(t, err)
	assert.Empty(t, stored.Outbox)
}

func TestRequeueOutboxEvent_ShouldClearLeaseAndUpdateRetryMetadata(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	ticket := &repository.Ticket{
		ID:         "ticket-outbox-requeue",
		Title:      "Concert",
		Price:      "10.00",
		UserID:     "seller-1",
		Quota:      10,
		MaxPerUser: 2,
		PendingOutbox: []repository.TicketOutboxEvent{
			repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketUpdated, repository.TicketOutboxPayload{}),
		},
	}
	require.NoError(t, repo.Create(ctx, ticket))

	claimed, err := repo.ClaimPendingOutboxEvents(ctx, 30*time.Second, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)

	nextAttemptAt := time.Now().UTC().Add(2 * time.Minute)
	err = repo.RequeueOutboxEvent(ctx, claimed[0].TicketID, claimed[0].Event.ID, claimed[0].Event.ClaimToken, "kafka unavailable", 3, nextAttemptAt)
	require.NoError(t, err)

	stored, err := repo.FindByID(ctx, claimed[0].TicketID)
	require.NoError(t, err)
	require.Len(t, stored.Outbox, 1)
	assert.Equal(t, 3, stored.Outbox[0].Attempts)
	assert.Equal(t, "kafka unavailable", stored.Outbox[0].LastError)
	assert.WithinDuration(t, nextAttemptAt, stored.Outbox[0].NextAttemptAt, time.Second)
	assert.Empty(t, stored.Outbox[0].ClaimToken)
	assert.Nil(t, stored.Outbox[0].LeaseUntil)
}

func TestClaimPendingOutboxEvents_ShouldReclaimExpiredLease(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	expiredLease := time.Now().UTC().Add(-time.Minute)
	event := repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketCreated, repository.TicketOutboxPayload{ID: "ticket-outbox-expired"})
	event.ClaimToken = "expired-claim"
	event.LeaseUntil = &expiredLease
	event.NextAttemptAt = time.Now().UTC().Add(-2 * time.Minute)

	ticket := &repository.Ticket{
		ID:         "ticket-outbox-expired",
		Title:      "Concert",
		Price:      "10.00",
		UserID:     "seller-1",
		Quota:      10,
		MaxPerUser: 2,
		Outbox:     []repository.TicketOutboxEvent{event},
	}
	require.NoError(t, repo.Create(ctx, ticket))

	claimed, err := repo.ClaimPendingOutboxEvents(ctx, 30*time.Second, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, "ticket-outbox-expired", claimed[0].TicketID)
	assert.NotEqual(t, "expired-claim", claimed[0].Event.ClaimToken)
	require.NotNil(t, claimed[0].Event.LeaseUntil)
	assert.True(t, claimed[0].Event.LeaseUntil.After(time.Now().UTC()))
}

func TestAcknowledgeOutboxEvent_ShouldRejectWrongClaimToken(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	repo := newRepoForReservationTests(t)
	ctx := context.Background()

	ticket := &repository.Ticket{
		ID:         "ticket-outbox-wrong-token",
		Title:      "Concert",
		Price:      "10.00",
		UserID:     "seller-1",
		Quota:      10,
		MaxPerUser: 2,
		PendingOutbox: []repository.TicketOutboxEvent{
			repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketCreated, repository.TicketOutboxPayload{}),
		},
	}
	require.NoError(t, repo.Create(ctx, ticket))

	claimed, err := repo.ClaimPendingOutboxEvents(ctx, 30*time.Second, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)

	err = repo.AcknowledgeOutboxEvent(ctx, claimed[0].TicketID, claimed[0].Event.ID, "wrong-token")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not claimed")
}
