package handler_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/acme/venue-service/internal/authz"
	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/acme/venue-service/internal/service"
	"github.com/labstack/echo/v4"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc"
)

const (
	acctA = "11111111-1111-1111-1111-111111111111"
	acctB = "22222222-2222-2222-2222-222222222222"
)

type allowAll struct {
	allowed bool
	err     error
	calls   int
}

func (f *allowAll) Check(_ context.Context, _ security.TrustedCaller, _ string, _ authz.Scope) (authz.Decision, error) {
	f.calls++
	if f.err != nil {
		return authz.Decision{Reason: authz.ReasonUnavailable}, f.err
	}
	if f.allowed {
		return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
	}
	return authz.Decision{Reason: authz.ReasonNotMember}, nil
}

type ticketOwner struct{ account string }

func (t ticketOwner) GetTicket(context.Context, *ticketsv1.GetTicketRequest, ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
	return &ticketsv1.GetTicketResponse{AccountId: t.account}, nil
}

func accessFor(mode authz.Mode, a *allowAll, ticketAccount string) *handler.Access {
	org := service.NewOrganizerAccess(a, mode, ticketOwner{ticketAccount}, nil, zap.NewNop())
	return handler.NewAccess(security.NewCallerVerifier(""), org)
}

func do(t *testing.T, method, path string, body any, headers map[string]string, call func(echo.Context) error, params ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, jsonBody(t, body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	c := newEcho().NewContext(req, rec)
	c.SetParamNames(params[:len(params)/2]...)
	c.SetParamValues(params[len(params)/2:]...)
	require.NoError(t, call(c))
	return rec
}

func TestVenueCreate_RecordsTheVerifiedAccountAsCreatorAndStartsUnverified(t *testing.T) {
	var saved *repository.Venue
	repo := &stubVenueRepo{createFn: func(_ context.Context, v *repository.Venue) error { saved = v; v.ID = "v1"; return nil }}
	h := handler.NewVenueHandler(repo, newSignatureValidator(), zap.NewNop()).WithAccess(accessFor(authz.ModeOn, &allowAll{allowed: true}, ""))
	body := map[string]any{"name": "Hall", "capacity": 10, "timezone": "UTC"}

	rec := do(t, http.MethodPost, "/api/venues", body, map[string]string{"X-User-Id": "u1", "X-Organizer-Account": acctA}, h.Create)
	assert.Equal(t, http.StatusCreated, rec.Code)
	assert.Equal(t, acctA, saved.CreatedByAccountID)

	rec = do(t, http.MethodPost, "/api/venues", body, map[string]string{"X-User-Id": "u1"}, h.Create)
	assert.Equal(t, http.StatusBadRequest, rec.Code, "enforcing, a missing acting account is a user error")
}

func TestVenueCreate_OutageIs503AndLogModeLeavesCreatorEmptyWithoutAccount(t *testing.T) {
	repo := &stubVenueRepo{createFn: func(_ context.Context, v *repository.Venue) error { v.ID = "v1"; return nil }}
	body := map[string]any{"name": "Hall", "capacity": 10, "timezone": "UTC"}
	hdr := map[string]string{"X-User-Id": "u1", "X-Organizer-Account": acctA}

	down := handler.NewVenueHandler(repo, newSignatureValidator(), zap.NewNop()).WithAccess(accessFor(authz.ModeOn, &allowAll{err: authz.ErrAuthzUnavailable}, ""))
	assert.Equal(t, http.StatusServiceUnavailable, do(t, http.MethodPost, "/api/venues", body, hdr, down.Create).Code)

	var saved *repository.Venue
	repo.createFn = func(_ context.Context, v *repository.Venue) error { saved = v; return nil }
	logging := handler.NewVenueHandler(repo, newSignatureValidator(), zap.NewNop()).WithAccess(accessFor(authz.ModeLog, &allowAll{}, ""))
	rec := do(t, http.MethodPost, "/api/venues", body, map[string]string{"X-User-Id": "u1"}, logging.Create)
	assert.Equal(t, http.StatusCreated, rec.Code)
	assert.Empty(t, saved.CreatedByAccountID)
}

// A venue team member did not create the venue, so the repository's owner guard
// must be given the stored owner once the permission check has passed them.
func TestVenueUpdate_ATeamMemberPassesTheOwnerGuardWithTheStoredOwner(t *testing.T) {
	var updated *repository.Venue
	repo := &stubVenueRepo{
		findByIDFn: func(context.Context, string) (*repository.Venue, error) {
			return &repository.Venue{ID: "v1", OrganizerID: "creator", Status: repository.VenueStatusVerified, CreatedByAccountID: acctA}, nil
		},
		updateFn: func(_ context.Context, v *repository.Venue) error { updated = v; return nil },
	}
	body := map[string]any{"name": "Hall", "capacity": 10, "timezone": "UTC"}
	hdr := map[string]string{"X-User-Id": "team-member", "X-Organizer-Account": acctB}

	h := handler.NewVenueHandler(repo, newSignatureValidator(), zap.NewNop()).WithAccess(accessFor(authz.ModeOn, &allowAll{allowed: true}, ""))
	rec := do(t, http.MethodPut, "/api/venues/v1", body, hdr, h.Update, "id", "v1")
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "creator", updated.OrganizerID)

	denied := handler.NewVenueHandler(repo, newSignatureValidator(), zap.NewNop()).WithAccess(accessFor(authz.ModeOn, &allowAll{}, ""))
	rec = do(t, http.MethodPut, "/api/venues/v1", body, hdr, denied.Update, "id", "v1")
	assert.Equal(t, http.StatusForbidden, rec.Code)
}

// Before enforcement is switched on, a non-owner must see exactly what they saw
// before, and user-service must not be able to change that.
func TestVenueUpdate_LogModeKeepsTheOldNotFoundForANonOwner(t *testing.T) {
	repo := &stubVenueRepo{
		findByIDFn: func(context.Context, string) (*repository.Venue, error) {
			return &repository.Venue{ID: "v1", OrganizerID: "creator", Status: repository.VenueStatusUnverified, CreatedByAccountID: acctA}, nil
		},
		updateFn: func(context.Context, *repository.Venue) error { t.Fatal("must not write"); return nil },
	}
	us := &allowAll{allowed: true}
	h := handler.NewVenueHandler(repo, newSignatureValidator(), zap.NewNop()).WithAccess(accessFor(authz.ModeLog, us, ""))
	rec := do(t, http.MethodPut, "/api/venues/v1", map[string]any{"name": "Hall", "capacity": 10, "timezone": "UTC"},
		map[string]string{"X-User-Id": "stranger", "X-Organizer-Account": acctA}, h.Update, "id", "v1")
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assert.JSONEq(t, `{"error":"venue not found"}`, rec.Body.String())
}

func TestPlanCreate_RefusesATicketTheAccountDoesNotOwn(t *testing.T) {
	created := false
	planRepo := &stubPlanRepo{createFn: func(_ context.Context, p *repository.SeatingPlan) error { created = true; p.ID = "p1"; return nil }}
	venues := &stubVenueRepo{findByIDFn: func(context.Context, string) (*repository.Venue, error) {
		return &repository.Venue{ID: "v1", OrganizerID: "u1", Status: repository.VenueStatusUnverified, CreatedByAccountID: acctA}, nil
	}}
	body := map[string]any{"venueId": "v1", "ticketId": "t1", "name": "Plan"}
	hdr := map[string]string{"X-User-Id": "u1", "X-Organizer-Account": acctA}

	notMine := handler.NewPlanHandler(planRepo, &nopSectionRepo{}, newSignatureValidator(), zap.NewNop()).
		WithAccess(accessFor(authz.ModeOn, &allowAll{allowed: true}, acctB), venues)
	rec := do(t, http.MethodPost, "/api/seating-plans", body, hdr, notMine.Create)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.False(t, created, "no plan is written for a ticket the account may not edit")

	mine := handler.NewPlanHandler(planRepo, &nopSectionRepo{}, newSignatureValidator(), zap.NewNop()).
		WithAccess(accessFor(authz.ModeOn, &allowAll{allowed: true}, acctA), venues)
	rec = do(t, http.MethodPost, "/api/seating-plans", body, hdr, mine.Create)
	assert.Equal(t, http.StatusCreated, rec.Code)
	assert.True(t, created)
}

func TestPlanCreate_FailsClosedWhenEnforcingWithoutAVenueRepository(t *testing.T) {
	created := false
	planRepo := &stubPlanRepo{createFn: func(_ context.Context, p *repository.SeatingPlan) error { created = true; return nil }}
	h := handler.NewPlanHandler(planRepo, &nopSectionRepo{}, newSignatureValidator(), zap.NewNop()).
		WithAccess(accessFor(authz.ModeOn, &allowAll{allowed: true}, acctA), nil)

	rec := do(t, http.MethodPost, "/api/seating-plans", map[string]any{"venueId": "v1", "ticketId": "t1", "name": "Plan"},
		map[string]string{"X-User-Id": "u1", "X-Organizer-Account": acctA}, h.Create)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.False(t, created, "without a venue the owning account is unknown, so no plan may be written")
}
