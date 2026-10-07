package graph_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/authz"
	graph "github.com/acme/venue-service/internal/graphql"
	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/acme/venue-service/internal/service"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc"
)

const acct = "11111111-1111-1111-1111-111111111111"

type countingAuthz struct {
	allowed bool
	err     error
	calls   int
}

func (c *countingAuthz) Check(context.Context, security.TrustedCaller, string, authz.Scope) (authz.Decision, error) {
	c.calls++
	if c.err != nil {
		return authz.Decision{Reason: authz.ReasonUnavailable}, c.err
	}
	if c.allowed {
		return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
	}
	return authz.Decision{Reason: authz.ReasonNotMember}, nil
}

type countingTickets struct{ calls int }

func (c *countingTickets) GetTicket(context.Context, *ticketsv1.GetTicketRequest, ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
	c.calls++
	return &ticketsv1.GetTicketResponse{AccountId: acct}, nil
}

type venueRepoStub struct {
	repository.VenueRepository
	venue   *repository.Venue
	created *repository.Venue
	updated *repository.Venue
}

func (v *venueRepoStub) Create(_ context.Context, x *repository.Venue) error {
	x.ID = "v1"
	v.created = x
	return nil
}
func (v *venueRepoStub) FindByID(context.Context, string) (*repository.Venue, error) {
	return v.venue, nil
}
func (v *venueRepoStub) Update(_ context.Context, x *repository.Venue) error {
	v.updated = x
	return nil
}

type holdStub struct{ held int }

func (h *holdStub) HoldSeats(context.Context, string, string, string, []string) (*hold.HoldResult, error) {
	h.held++
	return &hold.HoldResult{Held: []string{"s1"}, ExpiresAt: time.Now()}, nil
}
func (h *holdStub) ReleaseHold(context.Context, string, string, []string) error { h.held++; return nil }

func ctxWith(headers map[string]string) context.Context {
	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return graph.WithHTTPRequest(context.Background(), req)
}

func resolver(mode authz.Mode, a *countingAuthz, tk *countingTickets, venues *venueRepoStub, holds *holdStub) *graph.Resolver {
	return &graph.Resolver{
		VenueRepo: venues,
		HoldMgr:   holds,
		Access:    service.NewOrganizerAccess(a, mode, tk, nil, zap.NewNop()),
		Verifier:  security.NewCallerVerifier(""),
	}
}

func TestCreateVenue_RecordsTheVerifiedAccountAndNeedsOneWhenEnforcing(t *testing.T) {
	venues := &venueRepoStub{}
	r := resolver(authz.ModeOn, &countingAuthz{allowed: true}, &countingTickets{}, venues, &holdStub{})
	in := graph.CreateVenueInput{Name: "Hall", Capacity: 10, Timezone: "UTC"}

	_, err := r.Mutation().CreateVenue(ctxWith(map[string]string{"X-User-Id": "u1"}), in)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "choose an organizer account")

	_, err = r.Mutation().CreateVenue(ctxWith(map[string]string{"X-User-Id": "u1", "X-Organizer-Account": acct}), in)
	require.NoError(t, err)
	assert.Equal(t, acct, venues.created.CreatedByAccountID)
}

func TestUpdateVenue_ChecksTheStoredVenueNotTheHeader(t *testing.T) {
	venues := &venueRepoStub{venue: &repository.Venue{ID: "v1", OrganizerID: "creator", Status: repository.VenueStatusVerified}}
	hdr := map[string]string{"X-User-Id": "team", "X-Organizer-Account": acct}
	in := graph.UpdateVenueInput{Name: "Hall", Capacity: 10, Timezone: "UTC"}

	allowed := resolver(authz.ModeOn, &countingAuthz{allowed: true}, &countingTickets{}, venues, &holdStub{})
	_, err := allowed.Mutation().UpdateVenue(ctxWith(hdr), "v1", in)
	require.NoError(t, err)
	assert.Equal(t, "creator", venues.updated.OrganizerID, "stored owner passes the repository guard")

	denied := resolver(authz.ModeOn, &countingAuthz{}, &countingTickets{}, venues, &holdStub{})
	_, err = denied.Mutation().UpdateVenue(ctxWith(hdr), "v1", in)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")

	down := resolver(authz.ModeOn, &countingAuthz{err: authz.ErrAuthzUnavailable}, &countingTickets{}, venues, &holdStub{})
	_, err = down.Mutation().UpdateVenue(ctxWith(hdr), "v1", in)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unavailable")
}

// Buyers hold and release seats with only a sign-in. These paths must never
// ask user-service or ticket-service anything, whatever the mode.
func TestHoldAndReleaseSeats_NeverCallThePermissionCheckOrTicketService(t *testing.T) {
	for _, mode := range []authz.Mode{authz.ModeOff, authz.ModeLog, authz.ModeOn} {
		a, tk, holds := &countingAuthz{}, &countingTickets{}, &holdStub{}
		r := resolver(mode, a, tk, &venueRepoStub{}, holds)
		ctx := ctxWith(map[string]string{"X-User-Id": "buyer"})

		_, err := r.Mutation().HoldSeats(ctx, "plan-1", []string{"s1"})
		require.NoError(t, err)
		_, err = r.Mutation().ReleaseSeats(ctx, "plan-1", []string{"s1"})
		require.NoError(t, err)

		assert.Equal(t, 2, holds.held, string(mode))
		assert.Zero(t, a.calls, "mode %s: no permission calls", mode)
		assert.Zero(t, tk.calls, "mode %s: no ticket lookups", mode)
	}
}
