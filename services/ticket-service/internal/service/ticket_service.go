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
type CreateTicketInput struct {
	Title  string
	Price  float64
	UserID string
}

// UpdateTicketInput is the validated input for updating a ticket.
type UpdateTicketInput struct {
	ID     string
	Title  string
	Price  float64
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
func (s *TicketService) CreateTicket(ctx context.Context, input CreateTicketInput) (*repository.Ticket, error) {
	ticket := &repository.Ticket{
		Title:  input.Title,
		Price:  input.Price,
		UserID: input.UserID,
	}

	if err := s.repo.Create(ctx, ticket); err != nil {
		return nil, fmt.Errorf("create ticket: %w", err)
	}

	s.log.Info("ticket created", zap.String("ticketId", ticket.ID), zap.String("userId", ticket.UserID))

	if err := s.publisher.PublishTicketCreated(ctx, kafka.TicketEventData{
		ID:      ticket.ID,
		Title:   ticket.Title,
		Price:   ticket.Price,
		UserID:  ticket.UserID,
		Version: ticket.Version,
	}); err != nil {
		// Propagate the error — silently swallowing it would leave downstream services
		// (order-service) without the ticket.created event, causing silent data divergence.
		// The caller will receive a 500 and can retry the entire operation.
		s.log.Error("failed to publish ticket.created event", zap.Error(err), zap.String("ticketId", ticket.ID))
		return nil, fmt.Errorf("publish ticket.created event: %w", err)
	}

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

// ListTickets returns all tickets.
func (s *TicketService) ListTickets(ctx context.Context) ([]*repository.Ticket, error) {
	tickets, err := s.repo.FindAll(ctx)
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

	// Reservation check — cannot update a reserved ticket
	if ticket.OrderID != "" {
		return nil, repository.ErrTicketReserved
	}

	ticket.Title = input.Title
	ticket.Price = input.Price

	if err := s.repo.Update(ctx, ticket); err != nil {
		return nil, fmt.Errorf("update ticket: %w", err)
	}

	s.log.Info("ticket updated", zap.String("ticketId", ticket.ID), zap.String("userId", ticket.UserID))

	if err := s.publisher.PublishTicketUpdated(ctx, kafka.TicketEventData{
		ID:      ticket.ID,
		Title:   ticket.Title,
		Price:   ticket.Price,
		UserID:  ticket.UserID,
		Version: ticket.Version,
	}); err != nil {
		s.log.Error("failed to publish ticket.updated event", zap.Error(err), zap.String("ticketId", ticket.ID))
		return nil, fmt.Errorf("publish ticket.updated event: %w", err)
	}

	return ticket, nil
}
