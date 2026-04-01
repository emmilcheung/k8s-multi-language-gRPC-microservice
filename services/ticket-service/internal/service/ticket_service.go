package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
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
type CreateTicketInput struct {
	Title      string
	Price      string
	UserID     string
	Quota      int // defaults to 1 if 0
	MaxPerUser int // defaults to 1 if 0
}

// UpdateTicketInput is the validated input for updating a ticket.
type UpdateTicketInput struct {
	ID     string
	Title  string
	Price  string
	UserID string // used for ownership check
}

// ErrUnauthorized is returned when a user tries to modify a ticket they don't own.
var ErrUnauthorized = errors.New("not authorised to modify this ticket")

// TicketService contains the business logic for managing tickets.
type TicketService struct {
	repo      repository.TicketRepository
	publisher EventPublisher
	log       *zap.Logger
}

// NewTicketService creates a new TicketService with the given dependencies.
func NewTicketService(repo repository.TicketRepository, publisher EventPublisher, log *zap.Logger) *TicketService {
	return &TicketService{repo: repo, publisher: publisher, log: log}
}

// CreateTicket creates a new ticket and publishes a ticket.created event.
// The DB write is the source of truth; Kafka publish is fire-and-forget in a goroutine.
// If the publish fails, the error is logged at ERROR level (R-05: observable, not silent)
// but the gRPC call still returns success — ticket is already durably saved.
func (s *TicketService) CreateTicket(ctx context.Context, input CreateTicketInput) (*repository.Ticket, error) {
	ticket := &repository.Ticket{
		Title:      input.Title,
		Price:      input.Price,
		UserID:     input.UserID,
		Quota:      input.Quota,
		MaxPerUser: input.MaxPerUser,
	}

	if err := s.repo.Create(ctx, ticket); err != nil {
		return nil, fmt.Errorf("create ticket: %w", err)
	}

	s.log.Info("ticket created", zap.String("ticketId", ticket.ID), zap.String("userId", ticket.UserID))

	// Publish async — do not block or fail the gRPC response on Kafka availability.
	// MongoDB is the source of truth; Kafka is eventually consistent.
	eventData := kafka.TicketEventData{
		ID:      ticket.ID,
		Title:   ticket.Title,
		Price:   ticket.Price,
		UserID:  ticket.UserID,
		Version: ticket.Version,
	}
	go func() {
		if err := s.publisher.PublishTicketCreated(context.Background(), eventData); err != nil {
			s.log.Error("failed to publish ticket.created event", zap.Error(err), zap.String("ticketId", eventData.ID))
		}
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
		ID:      ticket.ID,
		Title:   ticket.Title,
		Price:   ticket.Price,
		UserID:  ticket.UserID,
		Version: ticket.Version,
	}
	go func() {
		if err := s.publisher.PublishTicketUpdated(context.Background(), eventData); err != nil {
			s.log.Error("failed to publish ticket.updated event", zap.Error(err), zap.String("ticketId", eventData.ID))
		}
	}()

	return ticket, nil
}
