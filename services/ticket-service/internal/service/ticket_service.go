package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"go.uber.org/zap"
	"google.golang.org/grpc"
)

// EventPublisher is the interface the service uses to publish domain events.
// The real Kafka producer and test mocks both implement this.
type EventPublisher interface {
	PublishTicketCreated(ctx context.Context, data kafka.TicketEventData) error
	PublishTicketUpdated(ctx context.Context, data kafka.TicketEventData) error
}

// SeatingPlanLookupClient narrows the venue-service dependency used by the
// ticket service so wrappers can add deadlines and circuit breaking without
// dragging the whole generated client into tests.
type SeatingPlanLookupClient interface {
	GetSeatingPlan(ctx context.Context, in *venuev1.GetSeatingPlanRequest, opts ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error)
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

// ErrVenueServiceUnavailable indicates venue-service could not be reached or
// its circuit breaker is open.
var ErrVenueServiceUnavailable = errors.New("venue-service unavailable")

// ErrVenueServiceTimeout indicates venue-service did not respond within the
// configured read budget.
var ErrVenueServiceTimeout = errors.New("venue-service deadline exceeded")

// TicketService contains the business logic for managing tickets.
type TicketService struct {
	repo               repository.TicketRepository
	publisher          EventPublisher
	log                *zap.Logger
	venueServiceClient SeatingPlanLookupClient // WS3: fetch seating plan assignment mode
}

// NewTicketService creates a new TicketService with the given dependencies.
func NewTicketService(repo repository.TicketRepository, publisher EventPublisher, log *zap.Logger, venueClient SeatingPlanLookupClient) *TicketService {
	return &TicketService{repo: repo, publisher: publisher, log: log, venueServiceClient: venueClient}
}

func buildOutboxPayload(ticket *repository.Ticket) repository.TicketOutboxPayload {
	payload := repository.TicketOutboxPayload{
		ID:            ticket.ID,
		Title:         ticket.Title,
		Price:         ticket.Price,
		UserID:        ticket.UserID,
		SeatingPlanID: ticket.SeatingPlanID,
		TicketType:    ticket.TicketType,
		Version:       ticket.Version,
	}
	if ticket.Event != nil {
		var endsAt string
		if ticket.Event.EndsAt != nil {
			endsAt = ticket.Event.EndsAt.Format(time.RFC3339)
		}
		payload.Event = &repository.TicketOutboxDetail{
			Title:        ticket.Event.Title,
			Description:  ticket.Event.Description,
			StartsAt:     ticket.Event.StartsAt.Format(time.RFC3339),
			EndsAt:       endsAt,
			ImageURL:     ticket.Event.ImageURL,
			VenueName:    ticket.Event.VenueName,
			VenueAddress: ticket.Event.VenueAddress,
		}
	}
	return payload
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
	ticket.PendingOutbox = []repository.TicketOutboxEvent{
		repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketCreated, buildOutboxPayload(ticket)),
	}

	if err := s.repo.Create(ctx, ticket); err != nil {
		return nil, fmt.Errorf("create ticket: %w", err)
	}
	ticket.PendingOutbox = nil

	s.log.Info("ticket created", zap.String("ticketId", ticket.ID), zap.String("userId", ticket.UserID))

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
	ticket.PendingOutbox = []repository.TicketOutboxEvent{
		repository.NewTicketOutboxEvent(repository.OutboxEventTypeTicketUpdated, buildOutboxPayload(ticket)),
	}

	if err := s.repo.Update(ctx, ticket); err != nil {
		return nil, fmt.Errorf("update ticket: %w", err)
	}
	ticket.PendingOutbox = nil

	s.log.Info("ticket updated", zap.String("ticketId", ticket.ID), zap.String("userId", ticket.UserID))

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
	existing, err := s.repo.FindByID(ctx, input.TicketID)
	if err != nil {
		return nil, fmt.Errorf("find ticket for attach: %w", err)
	}

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
	outboxEvent := repository.NewTicketOutboxEvent(
		repository.OutboxEventTypeTicketUpdated,
		buildOutboxPayload(&repository.Ticket{
			ID:            existing.ID,
			Title:         existing.Title,
			Price:         existing.Price,
			UserID:        existing.UserID,
			SeatingPlanID: input.PlanID,
			TicketType:    ticketType,
			Version:       existing.Version + 1,
			Event:         existing.Event,
		}),
	)

	if err := s.repo.AttachSeatingPlan(ctx, input.TicketID, input.PlanID, input.UserID, ticketType, &outboxEvent); err != nil {
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

	return ticket, nil
}

// DetachSeatingPlan removes the seating plan association from a ticket, reverting it to a GA
// ticket. The caller must own the ticket.
func (s *TicketService) DetachSeatingPlan(ctx context.Context, input DetachSeatingPlanInput) (*repository.Ticket, error) {
	existing, err := s.repo.FindByID(ctx, input.TicketID)
	if err != nil {
		return nil, fmt.Errorf("find ticket for detach: %w", err)
	}

	outboxEvent := repository.NewTicketOutboxEvent(
		repository.OutboxEventTypeTicketUpdated,
		buildOutboxPayload(&repository.Ticket{
			ID:         existing.ID,
			Title:      existing.Title,
			Price:      existing.Price,
			UserID:     existing.UserID,
			Version:    existing.Version + 1,
			Event:      existing.Event,
			TicketType: "",
		}),
	)
	if err := s.repo.DetachSeatingPlan(ctx, input.TicketID, input.UserID, &outboxEvent); err != nil {
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

	return ticket, nil
}
