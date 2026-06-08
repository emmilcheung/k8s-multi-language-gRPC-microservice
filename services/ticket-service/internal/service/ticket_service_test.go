package service_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc"
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
	if len(t.PendingOutbox) > 0 {
		for index := range t.PendingOutbox {
			t.PendingOutbox[index].Payload.ID = t.ID
			t.PendingOutbox[index].Payload.Title = t.Title
			t.PendingOutbox[index].Payload.Price = t.Price
			t.PendingOutbox[index].Payload.UserID = t.UserID
			t.PendingOutbox[index].Payload.SeatingPlanID = t.SeatingPlanID
			t.PendingOutbox[index].Payload.TicketType = t.TicketType
			t.PendingOutbox[index].Payload.Version = t.Version
		}
		t.Outbox = append(t.Outbox, t.PendingOutbox...)
		t.PendingOutbox = nil
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

func (m *mockRepo) FindByIDs(ctx context.Context, ids []string) ([]*repository.Ticket, error) {
	if m.err != nil {
		return nil, m.err
	}
	out := make([]*repository.Ticket, len(ids))
	for i, id := range ids {
		out[i] = m.tickets[id] // nil if not found
	}
	return out, nil
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
	t.Version++
	if len(t.PendingOutbox) > 0 {
		for index := range t.PendingOutbox {
			t.PendingOutbox[index].Payload.ID = t.ID
			t.PendingOutbox[index].Payload.Title = t.Title
			t.PendingOutbox[index].Payload.Price = t.Price
			t.PendingOutbox[index].Payload.UserID = t.UserID
			t.PendingOutbox[index].Payload.SeatingPlanID = t.SeatingPlanID
			t.PendingOutbox[index].Payload.TicketType = t.TicketType
			t.PendingOutbox[index].Payload.Version = t.Version
		}
		t.Outbox = append(t.Outbox, t.PendingOutbox...)
		t.PendingOutbox = nil
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

type flakyPublisher struct {
	mu             sync.Mutex
	failCreatedFor int
	createAttempts int
	createdEvents  []kafka.TicketEventData
}

func (m *flakyPublisher) PublishTicketCreated(_ context.Context, data kafka.TicketEventData) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.createAttempts++
	if m.createAttempts <= m.failCreatedFor {
		return errors.New("transient kafka error")
	}
	m.createdEvents = append(m.createdEvents, data)
	return nil
}

func (m *flakyPublisher) PublishTicketUpdated(_ context.Context, data kafka.TicketEventData) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.createdEvents = append(m.createdEvents, data)
	return nil
}

// --- Tests ---

// mockVenueClient is a stub for venue-service gRPC client
type mockVenueClient struct{}

func (*mockVenueClient) ReserveHeldSeats(_ context.Context, _ *venuev1.ReserveHeldSeatsRequest, _ ...grpc.CallOption) (*venuev1.ReserveHeldSeatsResponse, error) {
	return nil, nil
}

func (*mockVenueClient) AutoAssignAndReserve(_ context.Context, _ *venuev1.AutoAssignAndReserveRequest, _ ...grpc.CallOption) (*venuev1.AutoAssignAndReserveResponse, error) {
	return nil, nil
}

func (*mockVenueClient) ReleaseSeatReservation(_ context.Context, _ *venuev1.ReleaseSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.ReleaseSeatReservationResponse, error) {
	return nil, nil
}

func (*mockVenueClient) FinalizeSeatReservation(_ context.Context, _ *venuev1.FinalizeSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.FinalizeSeatReservationResponse, error) {
	return nil, nil
}

func (*mockVenueClient) GetSeatingPlan(_ context.Context, req *venuev1.GetSeatingPlanRequest, _ ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
	// Mock: return a plan with assignment_mode set based on plan ID (for testing)
	assignmentMode := "manual" // default to manual
	if req.PlanId == "auto-plan" {
		assignmentMode = "auto"
	}
	return &venuev1.GetSeatingPlanResponse{
		PlanId:         req.PlanId,
		AssignmentMode: assignmentMode,
	}, nil
}

// mockVenueClientUnavailable simulates venue-service being unavailable
type mockVenueClientUnavailable struct{}

func (*mockVenueClientUnavailable) ReserveHeldSeats(_ context.Context, _ *venuev1.ReserveHeldSeatsRequest, _ ...grpc.CallOption) (*venuev1.ReserveHeldSeatsResponse, error) {
	return nil, fmt.Errorf("%w: connection refused", service.ErrVenueServiceUnavailable)
}

func (*mockVenueClientUnavailable) AutoAssignAndReserve(_ context.Context, _ *venuev1.AutoAssignAndReserveRequest, _ ...grpc.CallOption) (*venuev1.AutoAssignAndReserveResponse, error) {
	return nil, fmt.Errorf("%w: connection refused", service.ErrVenueServiceUnavailable)
}

func (*mockVenueClientUnavailable) ReleaseSeatReservation(_ context.Context, _ *venuev1.ReleaseSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.ReleaseSeatReservationResponse, error) {
	return nil, fmt.Errorf("%w: connection refused", service.ErrVenueServiceUnavailable)
}

func (*mockVenueClientUnavailable) FinalizeSeatReservation(_ context.Context, _ *venuev1.FinalizeSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.FinalizeSeatReservationResponse, error) {
	return nil, fmt.Errorf("%w: connection refused", service.ErrVenueServiceUnavailable)
}

func (*mockVenueClientUnavailable) GetSeatingPlan(_ context.Context, _ *venuev1.GetSeatingPlanRequest, _ ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
	return nil, fmt.Errorf("%w: unavailable", service.ErrVenueServiceUnavailable)
}

// mockVenueClientTimeout simulates venue-service timing out
type mockVenueClientTimeout struct{}

func (*mockVenueClientTimeout) ReserveHeldSeats(_ context.Context, _ *venuev1.ReserveHeldSeatsRequest, _ ...grpc.CallOption) (*venuev1.ReserveHeldSeatsResponse, error) {
	return nil, fmt.Errorf("%w: deadline exceeded", service.ErrVenueServiceTimeout)
}

func (*mockVenueClientTimeout) AutoAssignAndReserve(_ context.Context, _ *venuev1.AutoAssignAndReserveRequest, _ ...grpc.CallOption) (*venuev1.AutoAssignAndReserveResponse, error) {
	return nil, fmt.Errorf("%w: deadline exceeded", service.ErrVenueServiceTimeout)
}

func (*mockVenueClientTimeout) ReleaseSeatReservation(_ context.Context, _ *venuev1.ReleaseSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.ReleaseSeatReservationResponse, error) {
	return nil, fmt.Errorf("%w: deadline exceeded", service.ErrVenueServiceTimeout)
}

func (*mockVenueClientTimeout) FinalizeSeatReservation(_ context.Context, _ *venuev1.FinalizeSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.FinalizeSeatReservationResponse, error) {
	return nil, fmt.Errorf("%w: deadline exceeded", service.ErrVenueServiceTimeout)
}

func (*mockVenueClientTimeout) GetSeatingPlan(_ context.Context, _ *venuev1.GetSeatingPlanRequest, _ ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
	return nil, fmt.Errorf("%w: deadline exceeded", service.ErrVenueServiceTimeout)
}

// mockVenueClientEmptyMode simulates venue-service returning empty assignment mode
type mockVenueClientEmptyMode struct{}

func (*mockVenueClientEmptyMode) ReserveHeldSeats(_ context.Context, _ *venuev1.ReserveHeldSeatsRequest, _ ...grpc.CallOption) (*venuev1.ReserveHeldSeatsResponse, error) {
	return nil, nil
}

func (*mockVenueClientEmptyMode) AutoAssignAndReserve(_ context.Context, _ *venuev1.AutoAssignAndReserveRequest, _ ...grpc.CallOption) (*venuev1.AutoAssignAndReserveResponse, error) {
	return nil, nil
}

func (*mockVenueClientEmptyMode) ReleaseSeatReservation(_ context.Context, _ *venuev1.ReleaseSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.ReleaseSeatReservationResponse, error) {
	return nil, nil
}

func (*mockVenueClientEmptyMode) FinalizeSeatReservation(_ context.Context, _ *venuev1.FinalizeSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.FinalizeSeatReservationResponse, error) {
	return nil, nil
}

func (*mockVenueClientEmptyMode) GetSeatingPlan(_ context.Context, _ *venuev1.GetSeatingPlanRequest, _ ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
	return &venuev1.GetSeatingPlanResponse{
		PlanId:         "plan-empty",
		AssignmentMode: "",
	}, nil
}

type mockVenueClientInactiveCurrent struct{}

func (*mockVenueClientInactiveCurrent) ReserveHeldSeats(_ context.Context, _ *venuev1.ReserveHeldSeatsRequest, _ ...grpc.CallOption) (*venuev1.ReserveHeldSeatsResponse, error) {
	return nil, nil
}

func (*mockVenueClientInactiveCurrent) AutoAssignAndReserve(_ context.Context, _ *venuev1.AutoAssignAndReserveRequest, _ ...grpc.CallOption) (*venuev1.AutoAssignAndReserveResponse, error) {
	return nil, nil
}

func (*mockVenueClientInactiveCurrent) ReleaseSeatReservation(_ context.Context, _ *venuev1.ReleaseSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.ReleaseSeatReservationResponse, error) {
	return nil, nil
}

func (*mockVenueClientInactiveCurrent) FinalizeSeatReservation(_ context.Context, _ *venuev1.FinalizeSeatReservationRequest, _ ...grpc.CallOption) (*venuev1.FinalizeSeatReservationResponse, error) {
	return nil, nil
}

func (*mockVenueClientInactiveCurrent) GetSeatingPlan(_ context.Context, req *venuev1.GetSeatingPlanRequest, _ ...grpc.CallOption) (*venuev1.GetSeatingPlanResponse, error) {
	if req.PlanId == "plan-1" {
		return &venuev1.GetSeatingPlanResponse{
			PlanId:         req.PlanId,
			Status:         "inactive",
			AssignmentMode: "manual",
		}, nil
	}
	return &venuev1.GetSeatingPlanResponse{
		PlanId:         req.PlanId,
		Status:         "draft",
		AssignmentMode: "manual",
	}, nil
}

func newSvc(repo repository.TicketRepository, pub service.EventPublisher) *service.TicketService {
	// For tests, we provide a no-op venue client and empty saved event repo since most tests don't need them
	return service.NewTicketService(repo, pub, zap.NewNop(), &mockVenueClient{}, newMockSavedEventRepo())
}

func TestCreateTicket_ShouldCreateTicketAndStoreOutboxEvent(t *testing.T) {
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
	assert.Len(t, ticket.Outbox, 1)
	assert.Equal(t, repository.OutboxEventTypeTicketCreated, ticket.Outbox[0].Type)
	assert.Equal(t, ticket.ID, ticket.Outbox[0].Payload.ID)
	assert.Equal(t, ticket.Version, ticket.Outbox[0].Payload.Version)
	assert.Empty(t, pub.createdEvents)
}

func TestCreateTicket_ShouldNotPublishDirectlyToKafka(t *testing.T) {
	repo := newMockRepo()
	pub := &flakyPublisher{failCreatedFor: 2}
	svc := newSvc(repo, pub)

	ticket, err := svc.CreateTicket(context.Background(), service.CreateTicketInput{
		Title:  "Concert Ticket",
		Price:  "99.99",
		UserID: "user-1",
	})

	require.NoError(t, err)
	pub.mu.Lock()
	defer pub.mu.Unlock()
	assert.Zero(t, pub.createAttempts)
	assert.Empty(t, pub.createdEvents)
	assert.Len(t, ticket.Outbox, 1)
	assert.Equal(t, repository.OutboxEventTypeTicketCreated, ticket.Outbox[0].Type)
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

func TestCreateTicket_ShouldSucceedEvenWhenPublisherWouldFail(t *testing.T) {
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
	assert.Len(t, ticket.Outbox, 1)
	assert.Empty(t, pub.createdEvents)
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

func TestUpdateTicket_ShouldUpdateAndStoreOutboxEvent(t *testing.T) {
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
	assert.Len(t, ticket.Outbox, 1)
	assert.Equal(t, repository.OutboxEventTypeTicketUpdated, ticket.Outbox[len(ticket.Outbox)-1].Type)
	assert.Equal(t, 2, ticket.Outbox[len(ticket.Outbox)-1].Payload.Version)
	assert.Empty(t, pub.updatedEvents)
}

func TestUpdateTicket_ShouldSucceedEvenWhenPublisherWouldFail(t *testing.T) {
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
	assert.Len(t, ticket.Outbox, 1)
	assert.Empty(t, pub.updatedEvents)
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

// --- Seating plan update tests ---

func TestUpdateTicket_ShouldAttachSeatingPlanWhenProvidedAndTicketHasNone(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	// Create a ticket without seating plan
	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "100.00", UserID: "user-1"})

	// Update with seating plan
	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "manual-plan",
	})

	require.NoError(t, err)
	assert.Equal(t, "manual-plan", ticket.SeatingPlanID)
	assert.Equal(t, "SEATED_MANUAL", ticket.TicketType)
	assert.Len(t, ticket.Outbox, 1)
}

func TestUpdateTicket_ShouldAttachSeatingPlanWithAutoAssignment(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	// Create a ticket without seating plan
	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "100.00", UserID: "user-1"})

	// Update with auto-assignment plan
	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "auto-plan",
	})

	require.NoError(t, err)
	assert.Equal(t, "auto-plan", ticket.SeatingPlanID)
	assert.Equal(t, "SEATED_AUTO", ticket.TicketType)
}

func TestUpdateTicket_ShouldReturnErrorWhenTryingToReplaceDifferentSeatingPlan(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	// Create a ticket with seating plan already attached
	repo.tickets["t1"] = &repository.Ticket{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-1",
		TicketType:    "SEATED_MANUAL",
		Quota:         1,
		MaxPerUser:    1,
		Version:       1,
	}

	// Try to update with a different seating plan
	_, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-2",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrSeatingPlanAlreadyAttached))
}

func TestUpdateTicket_ShouldAllowIdempotentSeatingPlanReattachment(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	// Create a ticket with seating plan already attached
	repo.tickets["t1"] = &repository.Ticket{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-1",
		TicketType:    "SEATED_MANUAL",
		Quota:         1,
		MaxPerUser:    1,
		Version:       1,
	}

	// Resend the same plan ID (idempotent)
	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert Updated",
		Price:         "150.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-1",
	})

	require.NoError(t, err)
	assert.Equal(t, "plan-1", ticket.SeatingPlanID)
	assert.Equal(t, "SEATED_MANUAL", ticket.TicketType)
	assert.Equal(t, "Concert Updated", ticket.Title)
	assert.Equal(t, "150.00", ticket.Price)
}

func TestUpdateTicket_ShouldAllowReplacingInactiveSeatingPlan(t *testing.T) {
	repo := newMockRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClientInactiveCurrent{}, newMockSavedEventRepo())

	repo.tickets["t1"] = &repository.Ticket{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-1",
		TicketType:    "SEATED_MANUAL",
		Quota:         1,
		MaxPerUser:    1,
		Version:       1,
	}

	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-2",
	})

	require.NoError(t, err)
	assert.Equal(t, "plan-2", ticket.SeatingPlanID)
	assert.Equal(t, "SEATED_MANUAL", ticket.TicketType)
}

func TestUpdateTicket_ShouldReturnUnavailableWhenVenueServiceUnreachable(t *testing.T) {
	repo := newMockRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClientUnavailable{}, newMockSavedEventRepo())

	// Create a ticket without seating plan
	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "100.00", UserID: "user-1"})

	// Try to update with seating plan when venue-service is unavailable
	_, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-1",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, service.ErrVenueServiceUnavailable))
}

func TestUpdateTicket_ShouldReturnTimeoutWhenVenueServiceTimesOut(t *testing.T) {
	repo := newMockRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClientTimeout{}, newMockSavedEventRepo())

	// Create a ticket without seating plan
	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "100.00", UserID: "user-1"})

	// Try to update with seating plan when venue-service times out
	_, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-1",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, service.ErrVenueServiceTimeout))
}

func TestUpdateTicket_ShouldUseFallbackTicketTypeWhenVenueReturnsEmptyMode(t *testing.T) {
	repo := newMockRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClientEmptyMode{}, newMockSavedEventRepo())

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "100.00", UserID: "user-1"})

	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-empty",
		TicketType:    "SEATED_AUTO",
	})

	require.NoError(t, err)
	assert.Equal(t, "plan-empty", ticket.SeatingPlanID)
	assert.Equal(t, "SEATED_AUTO", ticket.TicketType)
	assert.Len(t, ticket.Outbox, 1)
}

func TestUpdateTicket_ShouldUseEmptyTicketTypeWhenVenueReturnsEmptyModeAndNoFallback(t *testing.T) {
	repo := newMockRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClientEmptyMode{}, newMockSavedEventRepo())

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "100.00", UserID: "user-1"})

	ticket, err := svc.UpdateTicket(context.Background(), service.UpdateTicketInput{
		ID:            "t1",
		Title:         "Concert",
		Price:         "100.00",
		UserID:        "user-1",
		SeatingPlanID: "plan-empty",
	})

	require.NoError(t, err)
	assert.Equal(t, "plan-empty", ticket.SeatingPlanID)
	assert.Equal(t, "", ticket.TicketType)
	assert.Len(t, ticket.Outbox, 1)
}

// --- Mock saved event repository ---

type mockSavedEventRepo struct {
	savedEvents     map[string]map[string]bool     // userId -> eventId -> saved
	savedEventsList map[string][]*repository.SavedEvent // userId -> ordered list
	err             error
}

func newMockSavedEventRepo() *mockSavedEventRepo {
	return &mockSavedEventRepo{
		savedEvents:     make(map[string]map[string]bool),
		savedEventsList: make(map[string][]*repository.SavedEvent),
	}
}

func (m *mockSavedEventRepo) SaveEvent(ctx context.Context, userID, eventID string) error {
	if m.err != nil {
		return m.err
	}
	if m.savedEvents[userID] == nil {
		m.savedEvents[userID] = make(map[string]bool)
	}
	m.savedEvents[userID][eventID] = true
	return nil
}

func (m *mockSavedEventRepo) UnsaveEvent(ctx context.Context, userID, eventID string) error {
	if m.err != nil {
		return m.err
	}
	if m.savedEvents[userID] != nil {
		delete(m.savedEvents[userID], eventID)
	}
	return nil
}

func (m *mockSavedEventRepo) IsSaved(ctx context.Context, userID, eventID string) (bool, error) {
	if m.err != nil {
		return false, m.err
	}
	if m.savedEvents[userID] == nil {
		return false, nil
	}
	return m.savedEvents[userID][eventID], nil
}

func (m *mockSavedEventRepo) ListSavedEvents(ctx context.Context, userID string, after string, limit int) ([]*repository.SavedEvent, error) {
	if m.err != nil {
		return nil, m.err
	}
	events := m.savedEventsList[userID]
	if events == nil {
		return []*repository.SavedEvent{}, nil
	}
	
	// Create a reversed copy (newest first) to match repository behavior
	reversed := make([]*repository.SavedEvent, len(events))
	for i := range events {
		reversed[i] = events[len(events)-1-i]
	}
	
	// Simple pagination: find the "after" cursor and return the next `limit` items
	startIdx := 0
	if after != "" {
		for i, e := range reversed {
			cursor := repository.EncodeCursor(e.SavedAt, e.EventID)
			if cursor == after {
				startIdx = i + 1
				break
			}
		}
	}
	
	endIdx := startIdx + limit
	if endIdx > len(reversed) {
		endIdx = len(reversed)
	}
	
	if startIdx >= len(reversed) {
		return []*repository.SavedEvent{}, nil
	}
	
	return reversed[startIdx:endIdx], nil
}

// --- SaveEvent/UnsaveEvent tests ---

func TestSaveEvent_ShouldSaveEventForUser(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Create a ticket first so it exists
	repo.tickets["ticket-1"] = &repository.Ticket{ID: "ticket-1", Title: "Concert", Price: "50.00", UserID: "user-1"}

	ticket, err := svc.SaveEvent(context.Background(), "user-1", "ticket-1")

	require.NoError(t, err)
	assert.NotNil(t, ticket)
	assert.Equal(t, "ticket-1", ticket.ID)
	assert.Equal(t, "Concert", ticket.Title)
	saved, _ := savedEventRepo.IsSaved(context.Background(), "user-1", "ticket-1")
	assert.True(t, saved)
}

func TestSaveEvent_ShouldBeIdempotent(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Create a ticket first so it exists
	repo.tickets["ticket-1"] = &repository.Ticket{ID: "ticket-1", Title: "Concert", Price: "50.00", UserID: "user-1"}

	// Save twice
	ticket1, err := svc.SaveEvent(context.Background(), "user-1", "ticket-1")
	require.NoError(t, err)
	assert.NotNil(t, ticket1)
	ticket2, err := svc.SaveEvent(context.Background(), "user-1", "ticket-1")
	require.NoError(t, err)
	assert.NotNil(t, ticket2)

	saved, _ := savedEventRepo.IsSaved(context.Background(), "user-1", "ticket-1")
	assert.True(t, saved)
}

func TestSaveEvent_ShouldReturnErrorOnRepoFailure(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	savedEventRepo.err = errors.New("database error")
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Seed a valid ticket so FindByID succeeds and we exercise the savedEventRepo error path
	repo.tickets["ticket-1"] = &repository.Ticket{ID: "ticket-1", Title: "Concert", Price: "50.00", UserID: "user-1"}

	_, err := svc.SaveEvent(context.Background(), "user-1", "ticket-1")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "save event")
	assert.Contains(t, err.Error(), "database error")
}

func TestSaveEvent_ShouldFailForNonexistentTicket(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Try to save an event for a ticket that doesn't exist
	_, err := svc.SaveEvent(context.Background(), "user-1", "nonexistent-ticket-id")

	require.Error(t, err)
	assert.ErrorIs(t, err, repository.ErrTicketNotFound)
	// Verify the saved event was not persisted
	saved, _ := savedEventRepo.IsSaved(context.Background(), "user-1", "nonexistent-ticket-id")
	assert.False(t, saved)
}

func TestUnsaveEvent_ShouldRemoveSavedEvent(t *testing.T) {
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(newMockRepo(), &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Save then unsave
	_ = savedEventRepo.SaveEvent(context.Background(), "user-1", "ticket-1")
	err := svc.UnsaveEvent(context.Background(), "user-1", "ticket-1")

	require.NoError(t, err)
	saved, _ := savedEventRepo.IsSaved(context.Background(), "user-1", "ticket-1")
	assert.False(t, saved)
}

func TestUnsaveEvent_ShouldBeIdempotent(t *testing.T) {
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(newMockRepo(), &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Unsave twice (without saving first)
	err := svc.UnsaveEvent(context.Background(), "user-1", "ticket-1")
	require.NoError(t, err)
	err = svc.UnsaveEvent(context.Background(), "user-1", "ticket-1")
	require.NoError(t, err)

	saved, _ := savedEventRepo.IsSaved(context.Background(), "user-1", "ticket-1")
	assert.False(t, saved)
}

func TestUnsaveEvent_ShouldReturnErrorOnRepoFailure(t *testing.T) {
	savedEventRepo := newMockSavedEventRepo()
	savedEventRepo.err = errors.New("database error")
	svc := service.NewTicketService(newMockRepo(), &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	err := svc.UnsaveEvent(context.Background(), "user-1", "ticket-1")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsave event")
}

// --- ListSavedEvents tests ---

func TestListSavedEvents_ShouldReturnSavedEventsInNewestFirstOrder(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Create tickets
	repo.tickets["ticket-1"] = &repository.Ticket{ID: "ticket-1", Title: "Event A", Price: "10.00", UserID: "seller-1"}
	repo.tickets["ticket-2"] = &repository.Ticket{ID: "ticket-2", Title: "Event B", Price: "20.00", UserID: "seller-1"}
	repo.tickets["ticket-3"] = &repository.Ticket{ID: "ticket-3", Title: "Event C", Price: "30.00", UserID: "seller-1"}

	// Seed saved events in chronological order (oldest to newest)
	now := time.Now().UTC()
	savedEventRepo.savedEventsList["user-1"] = []*repository.SavedEvent{
		{UserID: "user-1", EventID: "ticket-3", SavedAt: now.Add(-10 * time.Second), UpdatedAt: now.Add(-10 * time.Second)},
		{UserID: "user-1", EventID: "ticket-2", SavedAt: now.Add(-5 * time.Second), UpdatedAt: now.Add(-5 * time.Second)},
		{UserID: "user-1", EventID: "ticket-1", SavedAt: now, UpdatedAt: now},
	}

	// List saved events
	tickets, err := svc.ListSavedEvents(context.Background(), "user-1", "", 10)

	require.NoError(t, err)
	require.Len(t, tickets, 3)
	// Should be in saved order (newest first)
	assert.Equal(t, "ticket-1", tickets[0].ID)
	assert.Equal(t, "Event A", tickets[0].Title)
	assert.Equal(t, "ticket-2", tickets[1].ID)
	assert.Equal(t, "Event B", tickets[1].Title)
	assert.Equal(t, "ticket-3", tickets[2].ID)
	assert.Equal(t, "Event C", tickets[2].Title)
}

func TestListSavedEvents_ShouldReturnEmptyListWhenNoSavedEvents(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	tickets, err := svc.ListSavedEvents(context.Background(), "user-1", "", 10)

	require.NoError(t, err)
	assert.Empty(t, tickets)
}

func TestListSavedEvents_ShouldSupportCursorPagination(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Create tickets
	repo.tickets["ticket-1"] = &repository.Ticket{ID: "ticket-1", Title: "Event A", Price: "10.00", UserID: "seller-1"}
	repo.tickets["ticket-2"] = &repository.Ticket{ID: "ticket-2", Title: "Event B", Price: "20.00", UserID: "seller-1"}
	repo.tickets["ticket-3"] = &repository.Ticket{ID: "ticket-3", Title: "Event C", Price: "30.00", UserID: "seller-1"}

	// Seed saved events
	now := time.Now().UTC()
	savedEventRepo.savedEventsList["user-1"] = []*repository.SavedEvent{
		{UserID: "user-1", EventID: "ticket-3", SavedAt: now.Add(-10 * time.Second), UpdatedAt: now.Add(-10 * time.Second)},
		{UserID: "user-1", EventID: "ticket-2", SavedAt: now.Add(-5 * time.Second), UpdatedAt: now.Add(-5 * time.Second)},
		{UserID: "user-1", EventID: "ticket-1", SavedAt: now, UpdatedAt: now},
	}

	// First page: get first 2
	tickets, err := svc.ListSavedEvents(context.Background(), "user-1", "", 2)
	require.NoError(t, err)
	require.Len(t, tickets, 2)
	assert.Equal(t, "ticket-1", tickets[0].ID)
	assert.Equal(t, "ticket-2", tickets[1].ID)

	// Second page: use cursor from last item
	cursor := repository.EncodeCursor(savedEventRepo.savedEventsList["user-1"][1].SavedAt, "ticket-2")
	tickets, err = svc.ListSavedEvents(context.Background(), "user-1", cursor, 2)
	require.NoError(t, err)
	require.Len(t, tickets, 1)
	assert.Equal(t, "ticket-3", tickets[0].ID)
}

func TestListSavedEvents_ShouldSkipDeletedTickets(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	// Create only 2 of the 3 tickets
	repo.tickets["ticket-1"] = &repository.Ticket{ID: "ticket-1", Title: "Event A", Price: "10.00", UserID: "seller-1"}
	repo.tickets["ticket-3"] = &repository.Ticket{ID: "ticket-3", Title: "Event C", Price: "30.00", UserID: "seller-1"}
	// ticket-2 is missing (deleted)

	// Seed saved events for 3 tickets
	now := time.Now().UTC()
	savedEventRepo.savedEventsList["user-1"] = []*repository.SavedEvent{
		{UserID: "user-1", EventID: "ticket-3", SavedAt: now.Add(-10 * time.Second), UpdatedAt: now.Add(-10 * time.Second)},
		{UserID: "user-1", EventID: "ticket-2", SavedAt: now.Add(-5 * time.Second), UpdatedAt: now.Add(-5 * time.Second)},
		{UserID: "user-1", EventID: "ticket-1", SavedAt: now, UpdatedAt: now},
	}

	tickets, err := svc.ListSavedEvents(context.Background(), "user-1", "", 10)

	require.NoError(t, err)
	require.Len(t, tickets, 2) // Should only return existing tickets
	assert.Equal(t, "ticket-1", tickets[0].ID)
	assert.Equal(t, "ticket-3", tickets[1].ID)
}

func TestListSavedEvents_ShouldReturnErrorOnRepoFailure(t *testing.T) {
	repo := newMockRepo()
	savedEventRepo := newMockSavedEventRepo()
	savedEventRepo.err = errors.New("database error")
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.NewNop(), &mockVenueClient{}, savedEventRepo)

	_, err := svc.ListSavedEvents(context.Background(), "user-1", "", 10)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "list saved events")
}

func TestCreateTicket_ShouldPersistCategoryAndDefaultToOther(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	// Test with explicit category
	ticket, err := svc.CreateTicket(context.Background(), service.CreateTicketInput{
		Title:    "Concert Ticket",
		Price:    "99.99",
		UserID:   "user-1",
		Category: "CONCERT",
	})

	require.NoError(t, err)
	assert.Equal(t, "CONCERT", ticket.Category)

	// Test with empty category (should default to OTHER)
	ticket2, err := svc.CreateTicket(context.Background(), service.CreateTicketInput{
		Title:  "Sports Ticket",
		Price:  "49.99",
		UserID: "user-1",
	})

	require.NoError(t, err)
	assert.Equal(t, "OTHER", ticket2.Category)
}
