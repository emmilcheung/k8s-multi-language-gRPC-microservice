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
// SeatingPlanID is optional; if provided and non-empty, attempts to attach a seating plan to the ticket.
// TicketType is optional; if provided, used as a fallback when venue-service returns empty assignment mode.
type UpdateTicketInput struct {
	ID            string
	Title         string
	Price         string
	UserID        string // used for ownership check
	SeatingPlanID string // optional; attach plan if non-empty
	TicketType    string // optional; fallback if venue-service returns empty assignment mode
	Event         *repository.TicketEvent
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
	savedEventRepo     repository.SavedEventRepository
}

// NewTicketService creates a new TicketService with the given dependencies.
func NewTicketService(repo repository.TicketRepository, publisher EventPublisher, log *zap.Logger, venueClient SeatingPlanLookupClient, savedEventRepo repository.SavedEventRepository) *TicketService {
	return &TicketService{
		repo:               repo,
		publisher:          publisher,
		log:                log,
		venueServiceClient: venueClient,
		savedEventRepo:     savedEventRepo,
	}
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

// GetTicketsByIDs retrieves multiple tickets by ID in a single query.
// The returned slice is in the same order as the input ids; missing tickets are nil.
func (s *TicketService) GetTicketsByIDs(ctx context.Context, ids []string) ([]*repository.Ticket, error) {
	tickets, err := s.repo.FindByIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("get tickets by ids: %w", err)
	}
	return tickets, nil
}

// ListTickets returns a page of tickets. Pass a zero-value PaginationParams for page 1 defaults.
func (s *TicketService) ListTickets(ctx context.Context, p repository.PaginationParams) ([]*repository.Ticket, error) {
	tickets, err := s.repo.FindAll(ctx, p)
	if err != nil {
		return nil, fmt.Errorf("list tickets: %w", err)
	}
	return tickets, nil
}

// UpdateTicket updates a ticket's title and price, and optionally attaches a seating plan.
// Enforces ownership and reservation checks.
//
// Seating plan logic:
//   - if a new non-empty different seatingPlanId is provided and current ticket has none,
//     calls venueServiceClient.GetSeatingPlan and sets TicketType
//   - if current ticket already has a different non-empty seatingPlanId, returns ErrSeatingPlanAlreadyAttached
//   - if same id is resent, treats as idempotent (no-op)
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
	if input.Event != nil {
		ticket.Event = input.Event
	}

	// Handle seating plan attachment if provided
	if input.SeatingPlanID != "" {
		// Check if trying to replace an existing different plan
		if ticket.SeatingPlanID != "" && ticket.SeatingPlanID != input.SeatingPlanID {
			currentPlanResp, err := s.venueServiceClient.GetSeatingPlan(ctx, &venuev1.GetSeatingPlanRequest{
				PlanId: ticket.SeatingPlanID,
			})
			if err != nil {
				s.log.Error("failed to fetch current seating plan from venue-service", zap.Error(err), zap.String("planId", ticket.SeatingPlanID))
				if errors.Is(err, ErrVenueServiceTimeout) {
					return nil, ErrVenueServiceTimeout
				}
				if errors.Is(err, ErrVenueServiceUnavailable) {
					return nil, ErrVenueServiceUnavailable
				}
				return nil, fmt.Errorf("venue-service lookup failed: %w", err)
			}
			if currentPlanResp.Status != "inactive" {
				return nil, repository.ErrSeatingPlanAlreadyAttached
			}
		}

		// If same plan ID is being reattached, treat as idempotent (no-op on plan)
		if ticket.SeatingPlanID != input.SeatingPlanID {
			// Fetch the seating plan from venue-service to get assignmentMode
			planResp, err := s.venueServiceClient.GetSeatingPlan(ctx, &venuev1.GetSeatingPlanRequest{
				PlanId: input.SeatingPlanID,
			})
			if err != nil {
				s.log.Error("failed to fetch seating plan from venue-service", zap.Error(err), zap.String("planId", input.SeatingPlanID))
				// Preserve the classified errors from the resilient venue client
				if errors.Is(err, ErrVenueServiceTimeout) {
					return nil, ErrVenueServiceTimeout
				}
				if errors.Is(err, ErrVenueServiceUnavailable) {
					return nil, ErrVenueServiceUnavailable
				}
				// Fallback for any other error (shouldn't happen with resilient client, but be defensive)
				return nil, fmt.Errorf("venue-service lookup failed: %w", err)
			}

			// Determine ticketType based on assignmentMode
			var ticketType string
			switch planResp.AssignmentMode {
			case "auto":
				ticketType = "SEATED_AUTO"
			case "manual":
				ticketType = "SEATED_MANUAL"
			default:
				// If venue-service returns empty/unknown assignment mode, fallback to caller-provided ticketType
				if input.TicketType != "" && (input.TicketType == "SEATED_AUTO" || input.TicketType == "SEATED_MANUAL") {
					ticketType = input.TicketType
					s.log.Info("using fallback ticketType from request", zap.String("ticketType", ticketType), zap.String("planId", input.SeatingPlanID))
				} else {
					s.log.Warn("unknown assignment mode from venue-service", zap.String("mode", planResp.AssignmentMode))
					ticketType = ""
				}
			}

			ticket.SeatingPlanID = input.SeatingPlanID
			ticket.TicketType = ticketType
		}
	}

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

// SaveEvent saves an event (ticket detail) for a user.
// In v1, eventId maps to ticketId. Idempotent: re-saving updates the timestamp.
// Verifies the ticket exists before saving to prevent orphan saved-event rows.
func (s *TicketService) SaveEvent(ctx context.Context, userID, eventID string) error {
	// Verify ticket exists before persisting the saved-event row
	if _, err := s.repo.FindByID(ctx, eventID); err != nil {
		return fmt.Errorf("save event: %w", err)
	}
	if err := s.savedEventRepo.SaveEvent(ctx, userID, eventID); err != nil {
		return fmt.Errorf("save event: %w", err)
	}
	s.log.Info("event saved", zap.String("userId", userID), zap.String("eventId", eventID))
	return nil
}

// UnsaveEvent removes a saved event for a user.
// In v1, eventId maps to ticketId. Idempotent: unsaving a non-saved event is a no-op.
func (s *TicketService) UnsaveEvent(ctx context.Context, userID, eventID string) error {
	if err := s.savedEventRepo.UnsaveEvent(ctx, userID, eventID); err != nil {
		return fmt.Errorf("unsave event: %w", err)
	}
	s.log.Info("event unsaved", zap.String("userId", userID), zap.String("eventId", eventID))
	return nil
}
