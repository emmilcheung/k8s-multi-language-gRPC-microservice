package service

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"time"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"go.uber.org/zap"
)

// EventPublisher is the interface the service uses to publish domain events.
// The real Kafka producer and test mocks both implement this.
type EventPublisher interface {
	PublishTicketCreated(ctx context.Context, data kafka.TicketEventData) error
	PublishTicketUpdated(ctx context.Context, data kafka.TicketEventData) error
}

// CreateTicketInput is the validated input for creating a ticket.
// Price is a decimal string (e.g. "9.99") — no float64 to avoid precision drift.
// Event is optional; if provided, StartsAt is required.
// WS8: Event metadata denormalization.
type CreateTicketInput struct {
	Title      string
	Price      string
	UserID     string
	Quota      int // defaults to 1 if 0
	MaxPerUser int // defaults to 1 if 0
	Event      *repository.TicketEvent
}

// UpdateTicketInput is the validated input for updating a ticket.
type UpdateTicketInput struct {
	ID     string
	Title  string
	Price  string
	UserID string // used for ownership check
}

// AttachSeatingPlanInput is the validated input for attaching a seating plan to a ticket.
type AttachSeatingPlanInput struct {
	TicketID string
	PlanID   string
	UserID   string // must own the ticket
}

// DetachSeatingPlanInput is the validated input for detaching a seating plan from a ticket.
type DetachSeatingPlanInput struct {
	TicketID string
	UserID   string // must own the ticket
}

// ErrUnauthorized is returned when a user tries to modify a ticket they don't own.
var ErrUnauthorized = errors.New("not authorised to modify this ticket")

// TicketService contains the business logic for managing tickets.
type TicketService struct {
	repo               repository.TicketRepository
	publisher          EventPublisher
	log                *zap.Logger
	venueServiceClient venuev1.VenueServiceClient // WS3: fetch seating plan assignment mode
}

// NewTicketService creates a new TicketService with the given dependencies.
func NewTicketService(repo repository.TicketRepository, publisher EventPublisher, log *zap.Logger, venueClient venuev1.VenueServiceClient) *TicketService {
	return &TicketService{repo: repo, publisher: publisher, log: log, venueServiceClient: venueClient}
}

// CreateTicket creates a new ticket and publishes a ticket.created event.
// The DB write is the source of truth; Kafka publish is fire-and-forget in a goroutine.
// If the publish fails, the error is logged at ERROR level (R-05: observable, not silent)
// but the gRPC call still returns success — ticket is already durably saved.
// Event validation: if Event is provided, StartsAt must not be zero.
func (s *TicketService) CreateTicket(ctx context.Context, input CreateTicketInput) (*repository.Ticket, error) {
	// WS8: Validate event if provided
	if input.Event != nil && input.Event.StartsAt.IsZero() {
		return nil, errors.New("event.startsAt is required")
	}

	ticket := &repository.Ticket{
		Title:      input.Title,
		Price:      input.Price,
		UserID:     input.UserID,
		Quota:      input.Quota,
		MaxPerUser: input.MaxPerUser,
		Event:      input.Event,
	}

	if err := s.repo.Create(ctx, ticket); err != nil {
		return nil, fmt.Errorf("create ticket: %w", err)
	}

	s.log.Info("ticket created", zap.String("ticketId", ticket.ID), zap.String("userId", ticket.UserID))

	// Publish async — do not block or fail the gRPC response on Kafka availability.
	// MongoDB is the source of truth; Kafka is eventually consistent.
	eventData := kafka.TicketEventData{
		ID:         ticket.ID,
		Title:      ticket.Title,
		Price:      ticket.Price,
		UserID:     ticket.UserID,
		TicketType: ticket.TicketType,
		Version:    ticket.Version,
	}
	// WS8: Include event metadata if present
	if ticket.Event != nil {
		var endsAt string
		if ticket.Event.EndsAt != nil {
			endsAt = ticket.Event.EndsAt.Format(time.RFC3339)
		}
		eventData.Event = &kafka.EventData{
			Title:        ticket.Event.Title,
			Description:  ticket.Event.Description,
			StartsAt:     ticket.Event.StartsAt.Format(time.RFC3339),
			EndsAt:       endsAt,
			ImageURL:     ticket.Event.ImageURL,
			VenueName:    ticket.Event.VenueName,
			VenueAddress: ticket.Event.VenueAddress,
		}
	}
	publishCtx := context.WithoutCancel(ctx)
	go func() {
		s.publishWithRetry(publishCtx, "ticket.created", eventData.ID, func() error {
			return s.publisher.PublishTicketCreated(publishCtx, eventData)
		})
	}()

	return ticket, nil
}

// GetTicketByID retrieves a ticket by ID.
func (s *TicketService) GetTicketByID(ctx context.Context, id string) (*repository.Ticket, error) {
	ticket, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("get ticket: %w", err)
	}
	return ticket, nil
}

// ListTickets returns a page of tickets. Pass a zero-value PaginationParams for page 1 defaults.
func (s *TicketService) ListTickets(ctx context.Context, p repository.PaginationParams) ([]*repository.Ticket, error) {
	tickets, err := s.repo.FindAll(ctx, p)
	if err != nil {
		return nil, fmt.Errorf("list tickets: %w", err)
	}
	return tickets, nil
}

// UpdateTicket updates a ticket's title and price, enforcing ownership and reservation checks.
func (s *TicketService) UpdateTicket(ctx context.Context, input UpdateTicketInput) (*repository.Ticket, error) {
	ticket, err := s.repo.FindByID(ctx, input.ID)
	if err != nil {
		return nil, fmt.Errorf("find ticket for update: %w", err)
	}

	// Ownership check — must happen before any write
	if ticket.UserID != input.UserID {
		return nil, ErrUnauthorized
	}

	// Reservation check — cannot update a ticket that has active reservations
	if ticket.Reserved > 0 {
		return nil, repository.ErrTicketReserved
	}

	ticket.Title = input.Title
	ticket.Price = input.Price

	if err := s.repo.Update(ctx, ticket); err != nil {
		return nil, fmt.Errorf("update ticket: %w", err)
	}

	s.log.Info("ticket updated", zap.String("ticketId", ticket.ID), zap.String("userId", ticket.UserID))

	// Publish async — do not block or fail the gRPC response on Kafka availability.
	eventData := kafka.TicketEventData{
		ID:            ticket.ID,
		Title:         ticket.Title,
		Price:         ticket.Price,
		UserID:        ticket.UserID,
		SeatingPlanID: ticket.SeatingPlanID,
		TicketType:    ticket.TicketType,
		Version:       ticket.Version,
	}
	// WS8: Include event metadata if present
	if ticket.Event != nil {
		var endsAt string
		if ticket.Event.EndsAt != nil {
			endsAt = ticket.Event.EndsAt.Format(time.RFC3339)
		}
		eventData.Event = &kafka.EventData{
			Title:        ticket.Event.Title,
			Description:  ticket.Event.Description,
			StartsAt:     ticket.Event.StartsAt.Format(time.RFC3339),
			EndsAt:       endsAt,
			ImageURL:     ticket.Event.ImageURL,
			VenueName:    ticket.Event.VenueName,
			VenueAddress: ticket.Event.VenueAddress,
		}
	}
	publishCtx := context.WithoutCancel(ctx)
	go func() {
		s.publishWithRetry(publishCtx, "ticket.updated", eventData.ID, func() error {
			return s.publisher.PublishTicketUpdated(publishCtx, eventData)
		})
	}()

	return ticket, nil
}

// AttachSeatingPlan links a venue-service seating plan UUID to the ticket.
// After attachment the ticket is "seated": the GA quota reservation path (ReserveQuota gRPC)
// will refuse to reserve seats for it, directing callers to the venue-service path instead.
//
// WS3: Fetches the seating plan's assignmentMode from venue-service and denormalizes it
// as ticketType ("SEATED_MANUAL" or "SEATED_AUTO") on the ticket.
//
// Validations performed here:
//   - ticketID and planID must be non-empty (format validated by the HTTP handler)
//   - ownership enforced in the repository layer (ErrOwnership → ErrUnauthorized)
//   - plan-already-attached detected atomically in the repository layer
func (s *TicketService) AttachSeatingPlan(ctx context.Context, input AttachSeatingPlanInput) (*repository.Ticket, error) {
	// WS3: Fetch the seating plan from venue-service to get assignmentMode
	planResp, err := s.venueServiceClient.GetSeatingPlan(ctx, &venuev1.GetSeatingPlanRequest{
		PlanId: input.PlanID,
	})
	if err != nil {
		s.log.Error("failed to fetch seating plan from venue-service", zap.Error(err), zap.String("planId", input.PlanID))
		return nil, fmt.Errorf("fetch seating plan: %w", err)
	}

	// Determine ticketType based on assignmentMode
	var ticketType string
	switch planResp.AssignmentMode {
	case "auto":
		ticketType = "SEATED_AUTO"
	case "manual":
		ticketType = "SEATED_MANUAL"
	default:
		s.log.Warn("unknown assignment mode from venue-service", zap.String("mode", planResp.AssignmentMode))
		ticketType = ""
	}

	if err := s.repo.AttachSeatingPlan(ctx, input.TicketID, input.PlanID, input.UserID, ticketType); err != nil {
		switch {
		case errors.Is(err, repository.ErrOwnership):
			return nil, ErrUnauthorized
		default:
			return nil, fmt.Errorf("attach seating plan: %w", err)
		}
	}

	ticket, err := s.repo.FindByID(ctx, input.TicketID)
	if err != nil {
		return nil, fmt.Errorf("fetch ticket after attach: %w", err)
	}

	s.log.Info("seating plan attached",
		zap.String("ticketId", ticket.ID),
		zap.String("seatingPlanId", ticket.SeatingPlanID),
		zap.String("ticketType", ticket.TicketType),
		zap.String("userId", input.UserID),
	)

	eventData := kafka.TicketEventData{
		ID:            ticket.ID,
		Title:         ticket.Title,
		Price:         ticket.Price,
		UserID:        ticket.UserID,
		SeatingPlanID: ticket.SeatingPlanID,
		TicketType:    ticket.TicketType,
		Version:       ticket.Version,
	}
	publishCtx := context.WithoutCancel(ctx)
	go func() {
		s.publishWithRetry(publishCtx, "ticket.updated", eventData.ID, func() error {
			return s.publisher.PublishTicketUpdated(publishCtx, eventData)
		})
	}()

	return ticket, nil
}

// DetachSeatingPlan removes the seating plan association from a ticket, reverting it to a GA
// ticket. The caller must own the ticket.
func (s *TicketService) DetachSeatingPlan(ctx context.Context, input DetachSeatingPlanInput) (*repository.Ticket, error) {
	if err := s.repo.DetachSeatingPlan(ctx, input.TicketID, input.UserID); err != nil {
		switch {
		case errors.Is(err, repository.ErrOwnership):
			return nil, ErrUnauthorized
		default:
			return nil, fmt.Errorf("detach seating plan: %w", err)
		}
	}

	ticket, err := s.repo.FindByID(ctx, input.TicketID)
	if err != nil {
		return nil, fmt.Errorf("fetch ticket after detach: %w", err)
	}

	s.log.Info("seating plan detached",
		zap.String("ticketId", ticket.ID),
		zap.String("userId", input.UserID),
	)

	eventData := kafka.TicketEventData{
		ID:      ticket.ID,
		Title:   ticket.Title,
		Price:   ticket.Price,
		UserID:  ticket.UserID,
		Version: ticket.Version,
		// SeatingPlanID and TicketType are intentionally empty — the plan was just detached.
	}
	publishCtx := context.WithoutCancel(ctx)
	go func() {
		s.publishWithRetry(publishCtx, "ticket.updated", eventData.ID, func() error {
			return s.publisher.PublishTicketUpdated(publishCtx, eventData)
		})
	}()

	return ticket, nil
}

// publishWithRetry retries fn up to maxRetries times using exponential backoff with jitter.
// It is designed for use inside fire-and-forget goroutines: errors are logged, not propagated.
// The context must not be cancelled before all retries complete — use context.WithoutCancel.
func (s *TicketService) publishWithRetry(ctx context.Context, eventType, ticketID string, fn func() error) {
	const maxRetries = 3
	const baseDelay = 200 * time.Millisecond
	const maxDelay = 5 * time.Second

	for attempt := 1; attempt <= maxRetries; attempt++ {
		if err := fn(); err == nil {
			return
		} else if attempt == maxRetries {
			s.log.Error("kafka publish failed after retries",
				zap.String("event", eventType),
				zap.String("ticketId", ticketID),
				zap.Error(err),
				zap.Int("attempts", maxRetries),
			)
			return
		} else {
			delay := publishBackoffWithJitter(attempt, baseDelay, maxDelay)
			s.log.Warn("kafka publish failed, retrying",
				zap.String("event", eventType),
				zap.String("ticketId", ticketID),
				zap.Int("attempt", attempt),
				zap.Duration("delay", delay),
			)
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		}
	}
}

// publishBackoffWithJitter returns a full-jitter exponential back-off duration.
func publishBackoffWithJitter(attempt int, base, max time.Duration) time.Duration {
	exp := base * (1 << attempt)
	if exp > max {
		exp = max
	}
	half := exp / 2
	jitter := time.Duration(rand.Int63n(int64(half) + 1)) //nolint:gosec // non-crypto jitter
	return half + jitter
}
