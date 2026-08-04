package outbox

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

type stubRelayRepo struct {
	claimed    []repository.ClaimedOutboxEvent
	claimErr   error
	acked      []ackCall
	ackErr     error
	requeues   []requeueCall
	requeueErr error
}

type ackCall struct {
	ticketID   string
	eventID    string
	claimToken string
}

type requeueCall struct {
	ticketID      string
	eventID       string
	claimToken    string
	lastErr       string
	attempts      int
	nextAttemptAt time.Time
}

func (s *stubRelayRepo) ClaimPendingOutboxEvents(_ context.Context, _ time.Duration, _ int) ([]repository.ClaimedOutboxEvent, error) {
	if s.claimErr != nil {
		return nil, s.claimErr
	}
	return s.claimed, nil
}

func (s *stubRelayRepo) AcknowledgeOutboxEvent(_ context.Context, ticketID, eventID, claimToken string) error {
	s.acked = append(s.acked, ackCall{ticketID: ticketID, eventID: eventID, claimToken: claimToken})
	return s.ackErr
}

func (s *stubRelayRepo) RequeueOutboxEvent(_ context.Context, ticketID, eventID, claimToken, lastErr string, attempts int, nextAttemptAt time.Time) error {
	s.requeues = append(s.requeues, requeueCall{
		ticketID:      ticketID,
		eventID:       eventID,
		claimToken:    claimToken,
		lastErr:       lastErr,
		attempts:      attempts,
		nextAttemptAt: nextAttemptAt,
	})
	return s.requeueErr
}

type stubRelayProducer struct {
	created []kafka.TicketEventData
	updated []kafka.TicketEventData
	err     error
}

func (s *stubRelayProducer) PublishTicketCreated(_ context.Context, data kafka.TicketEventData) error {
	if s.err != nil {
		return s.err
	}
	s.created = append(s.created, data)
	return nil
}

func (s *stubRelayProducer) PublishTicketUpdated(_ context.Context, data kafka.TicketEventData) error {
	if s.err != nil {
		return s.err
	}
	s.updated = append(s.updated, data)
	return nil
}

func TestRelayProcessClaimedEvent_ShouldAcknowledgePublishedEvent(t *testing.T) {
	repo := &stubRelayRepo{}
	producer := &stubRelayProducer{}
	relay := NewRelay(repo, producer, zap.NewNop())

	item := repository.ClaimedOutboxEvent{
		TicketID: "ticket-1",
		Event: repository.TicketOutboxEvent{
			ID:         "event-1",
			Type:       repository.OutboxEventTypeTicketCreated,
			ClaimToken: "claim-1",
			Payload: repository.TicketOutboxPayload{
				ID:         "ticket-1",
				Title:      "Concert",
				Price:      "10.00",
				UserID:     "seller-1",
				Quota:      50,
				Reserved:   5,
				Sold:       10,
				MaxPerUser: 4,
				Version:    1,
			},
		},
	}

	err := relay.processClaimedEvent(context.Background(), item)
	require.NoError(t, err)
	require.Len(t, producer.created, 1)
	assert.Equal(t, "ticket-1", producer.created[0].ID)
	assert.Equal(t, 50, producer.created[0].Quota)
	assert.Equal(t, 5, producer.created[0].Reserved)
	assert.Equal(t, 10, producer.created[0].Sold)
	assert.Equal(t, 4, producer.created[0].MaxPerUser)
	assert.Empty(t, producer.updated)
	require.Len(t, repo.acked, 1)
	assert.Equal(t, "ticket-1", repo.acked[0].ticketID)
	assert.Equal(t, "event-1", repo.acked[0].eventID)
	assert.Equal(t, "claim-1", repo.acked[0].claimToken)
	assert.Empty(t, repo.requeues)
}

func TestRelayProcessClaimedEvent_ShouldRequeueWhenPublishFails(t *testing.T) {
	repo := &stubRelayRepo{}
	producer := &stubRelayProducer{err: errors.New("kafka unavailable")}
	relay := NewRelay(repo, producer, zap.NewNop())

	startedAt := time.Now().UTC()
	item := repository.ClaimedOutboxEvent{
		TicketID: "ticket-1",
		Event: repository.TicketOutboxEvent{
			ID:         "event-1",
			Type:       repository.OutboxEventTypeTicketUpdated,
			ClaimToken: "claim-1",
			Payload: repository.TicketOutboxPayload{
				ID:      "ticket-1",
				Title:   "Concert",
				Price:   "10.00",
				UserID:  "seller-1",
				Version: 2,
			},
		},
	}

	err := relay.processClaimedEvent(context.Background(), item)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "kafka unavailable")
	assert.Empty(t, repo.acked)
	require.Len(t, repo.requeues, 1)
	assert.Equal(t, "ticket-1", repo.requeues[0].ticketID)
	assert.Equal(t, "event-1", repo.requeues[0].eventID)
	assert.Equal(t, "claim-1", repo.requeues[0].claimToken)
	assert.Equal(t, 1, repo.requeues[0].attempts)
	assert.Contains(t, repo.requeues[0].lastErr, "kafka unavailable")
	assert.WithinDuration(t, startedAt.Add(500*time.Millisecond), repo.requeues[0].nextAttemptAt, 300*time.Millisecond)
}

func TestRelayProcessBatch_ShouldProcessClaimedEvents(t *testing.T) {
	repo := &stubRelayRepo{
		claimed: []repository.ClaimedOutboxEvent{
			{
				TicketID: "ticket-1",
				Event: repository.TicketOutboxEvent{
					ID:         "event-1",
					Type:       repository.OutboxEventTypeTicketCreated,
					ClaimToken: "claim-1",
					Payload:    repository.TicketOutboxPayload{ID: "ticket-1", Title: "A", Price: "1.00", UserID: "user-1", Version: 1},
				},
			},
			{
				TicketID: "ticket-2",
				Event: repository.TicketOutboxEvent{
					ID:         "event-2",
					Type:       repository.OutboxEventTypeTicketUpdated,
					ClaimToken: "claim-2",
					Payload:    repository.TicketOutboxPayload{ID: "ticket-2", Title: "B", Price: "2.00", UserID: "user-2", Version: 2},
				},
			},
		},
	}
	producer := &stubRelayProducer{}
	relay := NewRelay(repo, producer, zap.NewNop())

	processed, err := relay.processBatch(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 2, processed)
	assert.Len(t, producer.created, 1)
	assert.Len(t, producer.updated, 1)
	assert.Len(t, repo.acked, 2)
}

func TestRelayPublish_ShouldMapEventMetadata(t *testing.T) {
	producer := &stubRelayProducer{}
	relay := NewRelay(&stubRelayRepo{}, producer, zap.NewNop())

	err := relay.publish(context.Background(), repository.TicketOutboxEvent{
		Type: repository.OutboxEventTypeTicketUpdated,
		Payload: repository.TicketOutboxPayload{
			ID:            "ticket-1",
			Title:         "Concert",
			Price:         "10.00",
			UserID:        "seller-1",
			SeatingPlanID: "plan-1",
			TicketType:    "SEATED_MANUAL",
			Version:       3,
			Event: &repository.TicketOutboxDetail{
				Title:        "Event",
				Description:  "desc",
				StartsAt:     time.Now().UTC().Format(time.RFC3339),
				VenueName:    "Arena",
				VenueAddress: "123 Street",
			},
		},
	})

	require.NoError(t, err)
	require.Len(t, producer.updated, 1)
	assert.Equal(t, "plan-1", producer.updated[0].SeatingPlanID)
	assert.Equal(t, "SEATED_MANUAL", producer.updated[0].TicketType)
	require.NotNil(t, producer.updated[0].Event)
	assert.Equal(t, "Arena", producer.updated[0].Event.VenueName)
}

func TestBackoffDelay_ShouldCapAtMaximum(t *testing.T) {
	assert.Equal(t, 500*time.Millisecond, backoffDelay(1))
	assert.Equal(t, time.Second, backoffDelay(2))
	assert.Equal(t, 30*time.Second, backoffDelay(10))
}

// An idle relay must not keep querying at the base poll interval: the claim
// query runs against the whole tickets collection, so a relay with nothing to
// publish would otherwise cost two queries per second per replica forever.
func TestNextIdleInterval_ShouldBackOffExponentially_WhenPollsAreEmpty(t *testing.T) {
	tests := []struct {
		name    string
		current time.Duration
		want    time.Duration
	}{
		{name: "doubles the base interval", current: defaultPollInterval, want: time.Second},
		{name: "keeps doubling below the cap", current: time.Second, want: 2 * time.Second},
		{name: "clamps at the cap", current: 4 * time.Second, want: maxIdlePollInterval},
		{name: "stays at the cap", current: maxIdlePollInterval, want: maxIdlePollInterval},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, nextIdleInterval(tc.current))
		})
	}
}

// Backing off must not cost publish latency: as soon as a poll returns work the
// relay has to be back at the base interval, otherwise an event arriving after a
// quiet period would wait up to maxIdlePollInterval to be published.
func TestRelayStart_ShouldResetBackoff_WhenPollReturnsWork(t *testing.T) {
	repo := &recordingRelayRepo{
		// Two empty polls (backoff grows), then one poll with work, then empty again.
		results: [][]repository.ClaimedOutboxEvent{
			{},
			{},
			{{TicketID: "tk_1", Event: repository.TicketOutboxEvent{
				ID: "evt_1", Type: repository.OutboxEventTypeTicketCreated, ClaimToken: "tok",
			}}},
			{},
		},
	}
	relay := NewRelay(repo, &stubRelayProducer{}, zap.NewNop())
	// Large enough that timer jitter is small relative to the interval, so the
	// doubling below is measurable rather than a coin flip.
	relay.pollInterval = 20 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	repo.stopAfter = len(repo.results)
	repo.cancel = cancel

	done := make(chan struct{})
	go func() { relay.Start(ctx); close(done) }()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("relay did not stop")
	}

	require.Len(t, repo.gaps, len(repo.results)-1)
	// gap[0]: after the 1st empty poll  -> base interval (~20ms)
	// gap[1]: after the 2nd empty poll  -> doubled     (~40ms)
	// gap[2]: after the poll with work  -> no wait at all (immediate continue)
	assert.Greater(t, repo.gaps[1], repo.gaps[0]*3/2,
		"an idle relay must back off: gap after the 2nd empty poll should be ~2x the base interval")
	assert.Less(t, repo.gaps[2], repo.gaps[0]/2,
		"a poll that returns work must not wait, so publish latency is unaffected by backoff")
}

// recordingRelayRepo records the wall-clock gap between successive claim calls
// and cancels the relay context once the scripted results are exhausted.
type recordingRelayRepo struct {
	results   [][]repository.ClaimedOutboxEvent
	calls     int
	last      time.Time
	gaps      []time.Duration
	stopAfter int
	cancel    context.CancelFunc
}

func (s *recordingRelayRepo) ClaimPendingOutboxEvents(_ context.Context, _ time.Duration, _ int) ([]repository.ClaimedOutboxEvent, error) {
	now := time.Now()
	if !s.last.IsZero() {
		s.gaps = append(s.gaps, now.Sub(s.last))
	}
	s.last = now

	if s.calls >= len(s.results) {
		s.cancel()
		return nil, nil
	}
	out := s.results[s.calls]
	s.calls++
	if s.calls >= s.stopAfter {
		defer s.cancel()
	}
	return out, nil
}

func (s *recordingRelayRepo) AcknowledgeOutboxEvent(_ context.Context, _, _, _ string) error {
	return nil
}

func (s *recordingRelayRepo) RequeueOutboxEvent(_ context.Context, _, _, _, _ string, _ int, _ time.Time) error {
	return nil
}

func TestRelay_TicketEventData_CarriesCategoryAndCreatedAt(t *testing.T) {
	created := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	payload := repository.TicketOutboxPayload{
		ID: "tk_1", Title: "Eras Tour", Category: "MUSIC", CreatedAt: created,
	}
	got := buildTicketEventData(payload) // the relay's payload->event mapper (see Step 3)
	require.Equal(t, "MUSIC", got.Category)
	require.Equal(t, created.Format(time.RFC3339), got.CreatedAt)
}
