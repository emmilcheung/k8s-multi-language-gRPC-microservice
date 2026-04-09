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
func (r *Relay) Start(ctx context.Context) {
	ticker := time.NewTicker(r.pollInterval)
	defer ticker.Stop()

	r.log.Info("ticket outbox relay started")
	defer r.log.Info("ticket outbox relay stopped")

	for {
		processed, err := r.processBatch(ctx)
		if err != nil {
			r.log.Error("ticket outbox batch failed", zap.Error(err))
		}
		if processed > 0 {
			continue
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
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

func (r *Relay) publish(ctx context.Context, event repository.TicketOutboxEvent) error {
	payload := kafka.TicketEventData{
		ID:            event.Payload.ID,
		Title:         event.Payload.Title,
		Price:         event.Payload.Price,
		UserID:        event.Payload.UserID,
		SeatingPlanID: event.Payload.SeatingPlanID,
		TicketType:    event.Payload.TicketType,
		Version:       event.Payload.Version,
	}
	if event.Payload.Event != nil {
		payload.Event = &kafka.EventData{
			Title:        event.Payload.Event.Title,
			Description:  event.Payload.Event.Description,
			StartsAt:     event.Payload.Event.StartsAt,
			EndsAt:       event.Payload.Event.EndsAt,
			ImageURL:     event.Payload.Event.ImageURL,
			VenueName:    event.Payload.Event.VenueName,
			VenueAddress: event.Payload.Event.VenueAddress,
		}
	}

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
