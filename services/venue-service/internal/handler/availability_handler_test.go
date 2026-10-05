package handler_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

type stubAvailabilityReader struct {
	fn    func(ctx context.Context, ticketID string) (*repository.TicketAvailability, error)
	calls int
}

func (s *stubAvailabilityReader) TicketAvailability(ctx context.Context, ticketID string) (*repository.TicketAvailability, error) {
	s.calls++
	return s.fn(ctx, ticketID)
}

const availabilityTicketID = "00000000-0000-0000-0000-000000000002"

func getAvailability(t *testing.T, reader *stubAvailabilityReader, ticketID string) *httptest.ResponseRecorder {
	t.Helper()
	e := newEcho()
	handler.NewAvailabilityHandler(reader, zap.NewNop()).RegisterRoutes(e)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/internal/tickets/"+ticketID+"/availability", nil))
	return rec
}

// The waiting room reads these two numbers to choose between "paused, seats
// may come back" and "sold out", so the field names are the contract.
func TestAvailabilityHandler_Get_ShouldReturnAvailableAndHeldCounts(t *testing.T) {
	reader := &stubAvailabilityReader{fn: func(_ context.Context, id string) (*repository.TicketAvailability, error) {
		assert.Equal(t, availabilityTicketID, id)
		return &repository.TicketAvailability{Available: 7, Held: 3}, nil
	}}

	rec := getAvailability(t, reader, availabilityTicketID)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"available":7,"held":3}`, rec.Body.String())
}

func TestAvailabilityHandler_Get_ShouldReturn404_WhenTicketHasNoActivePlan(t *testing.T) {
	reader := &stubAvailabilityReader{fn: func(context.Context, string) (*repository.TicketAvailability, error) {
		return nil, repository.ErrPlanNotFound
	}}

	assert.Equal(t, http.StatusNotFound, getAvailability(t, reader, availabilityTicketID).Code)
}

// A non-UUID id must be refused before it reaches the database.
func TestAvailabilityHandler_Get_ShouldReturn400_WhenTicketIdIsNotAUUID(t *testing.T) {
	reader := &stubAvailabilityReader{fn: func(context.Context, string) (*repository.TicketAvailability, error) {
		return &repository.TicketAvailability{}, nil
	}}

	rec := getAvailability(t, reader, "not-a-uuid")

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Zero(t, reader.calls, "an invalid id must not query the repository")
}

func TestAvailabilityHandler_Get_ShouldReturn500_WhenRepositoryFails(t *testing.T) {
	reader := &stubAvailabilityReader{fn: func(context.Context, string) (*repository.TicketAvailability, error) {
		return nil, errors.New("connection refused")
	}}

	rec := getAvailability(t, reader, availabilityTicketID)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotContains(t, rec.Body.String(), "connection refused", "internal errors must not leak to the caller")
}

// The route lives at the root, not under /api, because Kong only forwards /api.
func TestAvailabilityHandler_ShouldNotBeServedUnderAPI(t *testing.T) {
	e := newEcho()
	handler.NewAvailabilityHandler(&stubAvailabilityReader{}, zap.NewNop()).RegisterRoutes(e)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/internal/tickets/"+availabilityTicketID+"/availability", nil))
	assert.Equal(t, http.StatusNotFound, rec.Code)
}
