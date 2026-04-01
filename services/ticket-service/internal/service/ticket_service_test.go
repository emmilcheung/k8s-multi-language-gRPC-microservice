package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// --- Mock repository ---

type mockRepo struct {
	tickets      map[string]*repository.Ticket
	reservations map[string]*repository.TicketReservation
	err          error
}

func newMockRepo() *mockRepo {
	return &mockRepo{
		tickets:      make(map[string]*repository.Ticket),
		reservations: make(map[string]*repository.TicketReservation),
	}
}

func (m *mockRepo) Create(ctx context.Context, t *repository.Ticket) error {
	if m.err != nil {
		return m.err
	}
	if t.ID == "" {
		t.ID = "ticket-uuid-1"
	}
	t.Version = 1
	if t.Quota == 0 {
		t.Quota = 1
	}
	if t.MaxPerUser == 0 {
		t.MaxPerUser = 1
	}
	m.tickets[t.ID] = t
	return nil
}

func (m *mockRepo) FindByID(ctx context.Context, id string) (*repository.Ticket, error) {
	if m.err != nil {
		return nil, m.err
	}
	t, ok := m.tickets[id]
	if !ok {
		return nil, repository.ErrTicketNotFound
	}
	return t, nil
}

func (m *mockRepo) FindAll(ctx context.Context, _ repository.PaginationParams) ([]*repository.Ticket, error) {
	if m.err != nil {
		return nil, m.err
	}
	out := make([]*repository.Ticket, 0, len(m.tickets))
	for _, t := range m.tickets {
		out = append(out, t)
	}
	return out, nil
}

func (m *mockRepo) Update(ctx context.Context, t *repository.Ticket) error {
	if m.err != nil {
		return m.err
	}
	m.tickets[t.ID] = t
	return nil
}

func (m *mockRepo) Ping(ctx context.Context) error  { return m.err }
func (m *mockRepo) Close(ctx context.Context) error { return nil }

func (m *mockRepo) ReserveTicket(ctx context.Context, ticketID, orderID string) error {
	if m.err != nil {
		return m.err
	}
	t, ok := m.tickets[ticketID]
	if !ok {
		return repository.ErrTicketNotFound
	}
	t.OrderID = orderID
	return nil
}

func (m *mockRepo) ReleaseTicket(ctx context.Context, ticketID string) error {
	if m.err != nil {
		return m.err
	}
	t, ok := m.tickets[ticketID]
	if !ok {
		return repository.ErrTicketNotFound
	}
	t.OrderID = ""
	return nil
}

// Quota-based reservation stubs — minimal implementations sufficient for service unit tests.

func (m *mockRepo) CreateReservation(ctx context.Context, r *repository.TicketReservation) error {
	if m.err != nil {
		return m.err
	}
	m.reservations[r.ID] = r
	return nil
}

func (m *mockRepo) FindReservationByID(ctx context.Context, reservationID string) (*repository.TicketReservation, error) {
	if m.err != nil {
		return nil, m.err
	}
	r, ok := m.reservations[reservationID]
	if !ok {
		return nil, repository.ErrReservationNotFound
	}
	return r, nil
}

func (m *mockRepo) ReleaseReservation(ctx context.Context, reservationID string) error {
	if m.err != nil {
		return m.err
	}
	r, ok := m.reservations[reservationID]
	if !ok {
		return repository.ErrReservationNotFound
	}
	r.Status = repository.ReservationStatusReleased
	return nil
}

func (m *mockRepo) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	if m.err != nil {
		return m.err
	}
	r, ok := m.reservations[reservationID]
	if !ok {
		return repository.ErrReservationNotFound
	}
	r.Status = repository.ReservationStatusSold
	r.OrderID = orderID
	return nil
}

// --- Mock event publisher ---

type mockPublisher struct {
	createdEvents []kafka.TicketEventData
	updatedEvents []kafka.TicketEventData
	err           error
}

func (m *mockPublisher) PublishTicketCreated(_ context.Context, data kafka.TicketEventData) error {
	if m.err != nil {
		return m.err
	}
	m.createdEvents = append(m.createdEvents, data)
	return nil
}

func (m *mockPublisher) PublishTicketUpdated(_ context.Context, data kafka.TicketEventData) error {
	if m.err != nil {
		return m.err
	}
	m.updatedEvents = append(m.updatedEvents, data)
	return nil
}

// --- Tests ---

func newSvc(repo repository.TicketRepository, pub service.EventPublisher) *service.TicketService {
	return service.NewTicketService(repo, pub, zap.NewNop())
}

func TestCreateTicket_ShouldCreateTicketAndPublishEvent(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	ticket, err := svc.CreateTicket(context.Background(), service.CreateTicketInput{
		Title:  "Concert Ticket",
		Price:  "99.99",
		UserID: "user-1",
	})

	require.NoError(t, err)
	assert.Equal(t, "Concert Ticket", ticket.Title)
	assert.Equal(t, "99.99", ticket.Price)
	assert.Equal(t, "user-1", ticket.UserID)
	assert.NotEmpty(t, ticket.ID)

	// Kafka publish is async — give the goroutine time to run.
	time.Sleep(10 * time.Millisecond)
	assert.Len(t, pub.createdEvents, 1)
	assert.Equal(t, ticket.ID, pub.createdEvents[0].ID)
}

func TestCreateTicket_ShouldReturnErrorWhenRepoFails(t *testing.T) {
	repo := newMockRepo()
	repo.err = errors.New("db error")
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	_, err := svc.CreateTicket(context.Background(), service.CreateTicketInput{
		Title:  "Concert Ticket",
		Price:  "10.00",
		UserID: "user-1",
	})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "create ticket")
	assert.Empty(t, pub.createdEvents)
}

func TestCreateTicket_ShouldSucceedEvenWhenKafkaFails(t *testing.T) {
	// Kafka publish is fire-and-forget (goroutine). A publish failure must not
	// cause CreateTicket to return an error — the DB write is the source of truth (R-05).
	// The failure is logged at ERROR level so it remains observable.
	repo := newMockRepo()
	pub := &mockPublisher{err: errors.New("kafka unavailable")}
	svc := newSvc(repo, pub)

	ticket, err := svc.CreateTicket(context.Background(), service.CreateTicketInput{
		Title:  "Concert Ticket",
		Price:  "10.00",
		UserID: "user-1",
	})

	require.NoError(t, err)
	assert.NotNil(t, ticket)
	assert.NotEmpty(t, ticket.ID)
}

func TestGetTicketByID_ShouldReturnTicketWhenExists(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	// Seed a ticket
	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Test", Price: "5.00", UserID: "u1"})

	ticket, err := svc.GetTicketByID(context.Background(), "t1")
	require.NoError(t, err)
	assert.Equal(t, "t1", ticket.ID)
}

func TestGetTicketByID_ShouldReturnErrorWhenNotFound(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	_, err := svc.GetTicketByID(context.Background(), "nonexistent")
	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrTicketNotFound))
}

func TestListTickets_ShouldReturnAllTickets(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "A", Price: "1.00", UserID: "u1"})
	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t2", Title: "B", Price: "2.00", UserID: "u1"})

	tickets, err := svc.ListTickets(context.Background(), repository.PaginationParams{})
	require.NoError(t, err)
	assert.Len(t, tickets, 2)
}

func TestUpdateTicket_ShouldUpdateAndPublishEvent(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Old Title", Price: "5.00", UserID: "user-1"})

	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:     "t1",
		Title:  "New Title",
		Price:  "15.00",
		UserID: "user-1",
	})

	require.NoError(t, err)
	assert.Equal(t, "New Title", ticket.Title)
	assert.Equal(t, "15.00", ticket.Price)

	// Kafka publish is async — give the goroutine time to run.
	time.Sleep(10 * time.Millisecond)
	assert.Len(t, pub.updatedEvents, 1)
}

func TestUpdateTicket_ShouldSucceedEvenWhenKafkaFails(t *testing.T) {
	// Kafka publish is fire-and-forget (goroutine). A publish failure must not
	// cause UpdateTicket to return an error — the DB write is the source of truth (R-05).
	repo := newMockRepo()
	pub := &mockPublisher{err: errors.New("kafka unavailable")}
	svc := newSvc(repo, pub)

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Old Title", Price: "5.00", UserID: "user-1"})

	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:     "t1",
		Title:  "New Title",
		Price:  "15.00",
		UserID: "user-1",
	})

	require.NoError(t, err)
	assert.NotNil(t, ticket)
	assert.Equal(t, "New Title", ticket.Title)
}

func TestUpdateTicket_ShouldReturnUnauthorizedWhenUserDoesNotOwnTicket(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Title", Price: "5.00", UserID: "owner-user"})

	_, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:     "t1",
		Title:  "Hijacked",
		Price:  "1.00",
		UserID: "other-user",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, service.ErrUnauthorized))
}

func TestUpdateTicket_ShouldReturnErrorWhenTicketIsReserved(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	// Ticket with active reserved count is considered reserved
	repo.tickets["t1"] = &repository.Ticket{ID: "t1", Title: "Title", Price: "5.00", UserID: "user-1", Reserved: 1, Quota: 5, MaxPerUser: 5, Version: 1}

	_, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:     "t1",
		Title:  "New Title",
		Price:  "10.00",
		UserID: "user-1",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrTicketReserved))
}

func TestUpdateTicket_ShouldReturnNotFoundWhenTicketMissing(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	_, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:     "nonexistent",
		Title:  "Title",
		Price:  "5.00",
		UserID: "user-1",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrTicketNotFound))
}
