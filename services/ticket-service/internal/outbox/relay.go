package outbox

import (
	"context"
	"fmt"
	"time"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
	"go.uber.org/zap"
)

const (
	defaultPollInterval  = 500 * time.Millisecond
	defaultLeaseDuration = 30 * time.Second
	defaultBatchSize     = 20
	baseRetryDelay       = 500 * time.Millisecond
	maxRetryDelay        = 30 * time.Second
	// maxIdlePollInterval caps the exponential backoff applied to empty polls.
	// An idle relay settles at one query every 5s instead of two per second.
	maxIdlePollInterval = 5 * time.Second
)

type relayRepository interface {
	ClaimPendingOutboxEvents(ctx context.Context, leaseDuration time.Duration, limit int) ([]repository.ClaimedOutboxEvent, error)
	AcknowledgeOutboxEvent(ctx context.Context, ticketID, eventID, claimToken string) error
	RequeueOutboxEvent(ctx context.Context, ticketID, eventID, claimToken, lastErr string, attempts int, nextAttemptAt time.Time) error
}

type relayProducer interface {
	PublishTicketCreated(ctx context.Context, data kafka.TicketEventData) error
	PublishTicketUpdated(ctx context.Context, data kafka.TicketEventData) error
}

// Relay publishes durable ticket outbox events to Kafka and acknowledges them.
type Relay struct {
	repo          relayRepository
	producer      relayProducer
	log           *zap.Logger
	pollInterval  time.Duration
	leaseDuration time.Duration
	batchSize     int
}

// NewRelay creates a new ticket outbox relay.
func NewRelay(repo relayRepository, producer relayProducer, log *zap.Logger) *Relay {
	return &Relay{
		repo:          repo,
		producer:      producer,
		log:           log,
		pollInterval:  defaultPollInterval,
		leaseDuration: defaultLeaseDuration,
		batchSize:     defaultBatchSize,
	}
}

// Start runs the relay until ctx is cancelled.
//
// A poll that returns work is followed immediately by another poll. A poll that
// returns nothing backs off exponentially from pollInterval up to
// maxIdlePollInterval, resetting to pollInterval as soon as work appears again.
// This keeps publish latency at the base interval while an idle relay stops
// hammering the collection.
func (r *Relay) Start(ctx context.Context) {
	idleInterval := r.pollInterval
	timer := time.NewTimer(idleInterval)
	defer timer.Stop()

	r.log.Info("ticket outbox relay started")
	defer r.log.Info("ticket outbox relay stopped")

	for {
		processed, err := r.processBatch(ctx)
		if err != nil {
			r.log.Error("ticket outbox batch failed", zap.Error(err))
		}
		if processed > 0 {
			idleInterval = r.pollInterval
			continue
		}

		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(idleInterval)

		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}

		idleInterval = nextIdleInterval(idleInterval)
	}
}

// nextIdleInterval doubles the empty-poll backoff, capped at maxIdlePollInterval.
func nextIdleInterval(current time.Duration) time.Duration {
	if next := current * 2; next < maxIdlePollInterval {
		return next
	}
	return maxIdlePollInterval
}

func (r *Relay) processBatch(ctx context.Context) (int, error) {
	claimed, err := r.repo.ClaimPendingOutboxEvents(ctx, r.leaseDuration, r.batchSize)
	if err != nil {
		return 0, err
	}

	for _, item := range claimed {
		if err := r.processClaimedEvent(ctx, item); err != nil {
			r.log.Error("ticket outbox event failed",
				zap.String("ticketId", item.TicketID),
				zap.String("eventId", item.Event.ID),
				zap.String("eventType", string(item.Event.Type)),
				zap.Error(err),
			)
		}
	}

	return len(claimed), nil
}

func (r *Relay) processClaimedEvent(ctx context.Context, item repository.ClaimedOutboxEvent) error {
	err := r.publish(ctx, item.Event)
	if err == nil {
		if ackErr := r.repo.AcknowledgeOutboxEvent(ctx, item.TicketID, item.Event.ID, item.Event.ClaimToken); ackErr != nil {
			return fmt.Errorf("ack outbox event: %w", ackErr)
		}
		return nil
	}

	attempts := item.Event.Attempts + 1
	nextAttemptAt := time.Now().UTC().Add(backoffDelay(attempts))
	if requeueErr := r.repo.RequeueOutboxEvent(ctx, item.TicketID, item.Event.ID, item.Event.ClaimToken, err.Error(), attempts, nextAttemptAt); requeueErr != nil {
		return fmt.Errorf("requeue outbox event: %w", requeueErr)
	}
	return err
}

func buildTicketEventData(payload repository.TicketOutboxPayload) kafka.TicketEventData {
	data := kafka.TicketEventData{
		ID:            payload.ID,
		Title:         payload.Title,
		Price:         payload.Price,
		UserID:        payload.UserID,
		SeatingPlanID: payload.SeatingPlanID,
		TicketType:    payload.TicketType,
		Quota:         payload.Quota,
		Reserved:      payload.Reserved,
		Sold:          payload.Sold,
		MaxPerUser:    payload.MaxPerUser,
		Version:       payload.Version,
		Category:      payload.Category,
		CreatedAt:     payload.CreatedAt.Format(time.RFC3339),
	}
	if payload.Event != nil {
		data.Event = &kafka.EventData{
			Title:        payload.Event.Title,
			Description:  payload.Event.Description,
			StartsAt:     payload.Event.StartsAt,
			EndsAt:       payload.Event.EndsAt,
			ImageURL:     payload.Event.ImageURL,
			VenueName:    payload.Event.VenueName,
			VenueAddress: payload.Event.VenueAddress,
		}
	}
	return data
}

func (r *Relay) publish(ctx context.Context, event repository.TicketOutboxEvent) error {
	payload := buildTicketEventData(event.Payload)

	switch event.Type {
	case repository.OutboxEventTypeTicketCreated:
		return r.producer.PublishTicketCreated(ctx, payload)
	case repository.OutboxEventTypeTicketUpdated:
		return r.producer.PublishTicketUpdated(ctx, payload)
	default:
		return fmt.Errorf("unsupported outbox event type %q", event.Type)
	}
}

func backoffDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := baseRetryDelay * (1 << (attempt - 1))
	if delay > maxRetryDelay {
		return maxRetryDelay
	}
	return delay
}
