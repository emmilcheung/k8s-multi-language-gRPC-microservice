package service_test

import (
	"context"
	"errors"
	"sync"
	"testing"

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

// attachErr / detachErr allow per-call error injection distinct from the generic m.err.
// These are separate fields so tests can inject targeted errors without breaking other methods.

func (m *mockRepo) AttachSeatingPlan(ctx context.Context, ticketID, planID, userID, ticketType string, outbox *repository.TicketOutboxEvent) error {
	if m.err != nil {
		return m.err
	}
	t, ok := m.tickets[ticketID]
	if !ok {
		return repository.ErrTicketNotFound
	}
	if t.UserID != userID {
		return repository.ErrOwnership
	}
	if t.SeatingPlanID != "" {
		return repository.ErrSeatingPlanAlreadyAttached
	}
	t.SeatingPlanID = planID
	t.TicketType = ticketType
	t.Version++
	if outbox != nil {
		outbox.Payload.ID = t.ID
		outbox.Payload.Title = t.Title
		outbox.Payload.Price = t.Price
		outbox.Payload.UserID = t.UserID
		outbox.Payload.SeatingPlanID = t.SeatingPlanID
		outbox.Payload.TicketType = t.TicketType
		outbox.Payload.Version = t.Version
		t.Outbox = append(t.Outbox, *outbox)
	}
	return nil
}

func (m *mockRepo) DetachSeatingPlan(ctx context.Context, ticketID, userID string, outbox *repository.TicketOutboxEvent) error {
	if m.err != nil {
		return m.err
	}
	t, ok := m.tickets[ticketID]
	if !ok {
		return repository.ErrTicketNotFound
	}
	if t.UserID != userID {
		return repository.ErrOwnership
	}
	t.SeatingPlanID = ""
	t.TicketType = ""
	t.Version++
	if outbox != nil {
		outbox.Payload.ID = t.ID
		outbox.Payload.Title = t.Title
		outbox.Payload.Price = t.Price
		outbox.Payload.UserID = t.UserID
		outbox.Payload.Version = t.Version
		t.Outbox = append(t.Outbox, *outbox)
	}
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

func newSvc(repo repository.TicketRepository, pub service.EventPublisher) *service.TicketService {
	// For tests, we provide a no-op venue client since most tests don't attach plans
	return service.NewTicketService(repo, pub, zap.NewNop(), &mockVenueClient{})
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

// ── AttachSeatingPlan ─────────────────────────────────────────────────────────

func TestAttachSeatingPlan_ShouldAttachAndStoreOutboxEvent(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "50.00", UserID: "owner-1"})

	ticket, err := svc.AttachSeatingPlan(context.Background(), service.AttachSeatingPlanInput{
		TicketID: "t1",
		PlanID:   "plan-uuid-1",
		UserID:   "owner-1",
	})

	require.NoError(t, err)
	assert.Equal(t, "plan-uuid-1", ticket.SeatingPlanID)
	assert.Equal(t, "SEATED_MANUAL", ticket.TicketType)
	require.Len(t, ticket.Outbox, 1)
	assert.Equal(t, repository.OutboxEventTypeTicketUpdated, ticket.Outbox[len(ticket.Outbox)-1].Type)
	assert.Equal(t, "plan-uuid-1", ticket.Outbox[len(ticket.Outbox)-1].Payload.SeatingPlanID)
	assert.Equal(t, "SEATED_MANUAL", ticket.Outbox[len(ticket.Outbox)-1].Payload.TicketType)
	assert.Empty(t, pub.updatedEvents)
}

func TestAttachSeatingPlan_ShouldStoreAutoAssignedTicketTypeInOutbox(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "50.00", UserID: "owner-1"})

	ticket, err := svc.AttachSeatingPlan(context.Background(), service.AttachSeatingPlanInput{
		TicketID: "t1",
		PlanID:   "auto-plan",
		UserID:   "owner-1",
	})

	require.NoError(t, err)
	assert.Equal(t, "SEATED_AUTO", ticket.TicketType)
	require.Len(t, ticket.Outbox, 1)
	assert.Equal(t, "SEATED_AUTO", ticket.Outbox[len(ticket.Outbox)-1].Payload.TicketType)
	assert.Empty(t, pub.updatedEvents)
}

func TestAttachSeatingPlan_ShouldReturnUnauthorizedWhenNotOwner(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	_ = repo.Create(context.Background(), &repository.Ticket{ID: "t1", Title: "Concert", Price: "50.00", UserID: "owner-1"})

	_, err := svc.AttachSeatingPlan(context.Background(), service.AttachSeatingPlanInput{
		TicketID: "t1",
		PlanID:   "plan-uuid-1",
		UserID:   "attacker",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, service.ErrUnauthorized))
}

func TestAttachSeatingPlan_ShouldReturnNotFoundWhenTicketMissing(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	_, err := svc.AttachSeatingPlan(context.Background(), service.AttachSeatingPlanInput{
		TicketID: "nonexistent",
		PlanID:   "plan-uuid-1",
		UserID:   "owner-1",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrTicketNotFound))
}

func TestAttachSeatingPlan_ShouldReturnErrorWhenPlanAlreadyAttached(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	// Seed a ticket that already has a seating plan.
	repo.tickets["t1"] = &repository.Ticket{
		ID: "t1", Title: "Concert", Price: "50.00", UserID: "owner-1",
		SeatingPlanID: "existing-plan", Quota: 1, MaxPerUser: 1, Version: 1,
	}

	_, err := svc.AttachSeatingPlan(context.Background(), service.AttachSeatingPlanInput{
		TicketID: "t1",
		PlanID:   "new-plan",
		UserID:   "owner-1",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrSeatingPlanAlreadyAttached))
}

// ── DetachSeatingPlan ─────────────────────────────────────────────────────────

func TestDetachSeatingPlan_ShouldDetachAndStoreOutboxEvent(t *testing.T) {
	repo := newMockRepo()
	pub := &mockPublisher{}
	svc := newSvc(repo, pub)

	// Seed a ticket with a seating plan already attached.
	repo.tickets["t1"] = &repository.Ticket{
		ID: "t1", Title: "Concert", Price: "50.00", UserID: "owner-1",
		SeatingPlanID: "plan-uuid-1", TicketType: "SEATED_MANUAL", Quota: 1, MaxPerUser: 1, Version: 1,
	}

	ticket, err := svc.DetachSeatingPlan(context.Background(), service.DetachSeatingPlanInput{
		TicketID: "t1",
		UserID:   "owner-1",
	})

	require.NoError(t, err)
	assert.Empty(t, ticket.SeatingPlanID)
	assert.Empty(t, ticket.TicketType)
	require.Len(t, ticket.Outbox, 1)
	assert.Equal(t, repository.OutboxEventTypeTicketUpdated, ticket.Outbox[len(ticket.Outbox)-1].Type)
	assert.Empty(t, ticket.Outbox[len(ticket.Outbox)-1].Payload.SeatingPlanID)
	assert.Empty(t, ticket.Outbox[len(ticket.Outbox)-1].Payload.TicketType)
	assert.Empty(t, pub.updatedEvents)
}

func TestDetachSeatingPlan_ShouldReturnUnauthorizedWhenNotOwner(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	repo.tickets["t1"] = &repository.Ticket{
		ID: "t1", Title: "Concert", Price: "50.00", UserID: "owner-1",
		SeatingPlanID: "plan-uuid-1", Quota: 1, MaxPerUser: 1, Version: 1,
	}

	_, err := svc.DetachSeatingPlan(context.Background(), service.DetachSeatingPlanInput{
		TicketID: "t1",
		UserID:   "attacker",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, service.ErrUnauthorized))
}

func TestDetachSeatingPlan_ShouldReturnNotFoundWhenTicketMissing(t *testing.T) {
	repo := newMockRepo()
	svc := newSvc(repo, &mockPublisher{})

	_, err := svc.DetachSeatingPlan(context.Background(), service.DetachSeatingPlanInput{
		TicketID: "nonexistent",
		UserID:   "owner-1",
	})

	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrTicketNotFound))
}
