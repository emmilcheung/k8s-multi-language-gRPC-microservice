package graph_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/acme/ticket-service/internal/audit"
	"github.com/acme/ticket-service/internal/authz"
	graph "github.com/acme/ticket-service/internal/graphql"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/security"
	"github.com/acme/ticket-service/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

const (
	orgA = "11111111-1111-4111-8111-111111111111"
	orgB = "22222222-2222-4222-8222-222222222222"
)

// stubRepo implements only what these queries touch; any other call panics on
// the nil embedded interface, which would fail the test loudly.
type stubRepo struct {
	repository.TicketRepository
	tickets map[string]*repository.Ticket
}

func (r *stubRepo) FindByID(_ context.Context, id string) (*repository.Ticket, error) {
	if t, ok := r.tickets[id]; ok {
		return t, nil
	}
	return nil, repository.ErrTicketNotFound
}

func (r *stubRepo) FindAll(context.Context, repository.PaginationParams) ([]*repository.Ticket, error) {
	return nil, nil
}

func (r *stubRepo) Update(_ context.Context, t *repository.Ticket) error {
	t.Version++
	return nil
}

type stubSaved struct {
	repository.SavedEventRepository
}

func (stubSaved) IsSaved(context.Context, string, string) (bool, error) { return false, nil }

type stubReads struct {
	byAccount map[string][]*repository.Ticket
	history   []repository.AuditRecord
}

func (r *stubReads) FindByAccount(_ context.Context, accountID string, limit int, _ string) ([]*repository.Ticket, error) {
	out := r.byAccount[accountID]
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (r *stubReads) ListAuditByResource(_ context.Context, _ string, limit int, _ string) ([]repository.AuditRecord, error) {
	if len(r.history) > limit {
		return r.history[:limit], nil
	}
	return r.history, nil
}

// memberAuthz allows event.view / event.edit to the listed users on one account.
type memberAuthz struct {
	allowed map[string]bool // user|account
	calls   atomic.Int32
}

func (a *memberAuthz) Check(_ context.Context, c security.TrustedCaller, _ string, s authz.Scope) (authz.Decision, error) {
	a.calls.Add(1)
	if a.allowed[c.UserID+"|"+s.AccountID] {
		return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
	}
	return authz.Decision{Reason: authz.ReasonNotMember}, nil
}

type gqlResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func newServer(t *testing.T, repo *stubRepo, reads *stubReads, a *memberAuthz) *service.TicketService {
	t.Helper()
	svc := service.NewTicketService(repo, nil, zap.NewNop(), nil, stubSaved{})
	svc.WithAuthz(a, authz.ModeOn)
	svc.WithAccountReads(reads)
	return svc
}

func run(t *testing.T, svc *service.TicketService, userID, acting, query string) gqlResponse {
	t.Helper()
	srv := handler.NewDefaultServer(graph.NewExecutableSchema(graph.Config{Resolvers: &graph.Resolver{TicketService: svc}}))
	body, err := json.Marshal(map[string]string{"query": query})
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/graphql", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	ctx := graph.WithUserID(req.Context(), userID)
	ctx = graph.WithCaller(ctx, security.TrustedCaller{UserID: userID})
	ctx = graph.WithOrganizerAccount(ctx, acting)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req.WithContext(ctx))
	var out gqlResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
	return out
}

func ticketIn(id, account string, at time.Time) *repository.Ticket {
	return &repository.Ticket{ID: id, Title: "Show " + id, Price: "10.00", UserID: "creator", AccountID: account, CreatedAt: at, UpdatedAt: at}
}

func TestEventsByAccount_ShouldListAnAccountsEventsForAMemberAndRefuseOutsiders(t *testing.T) {
	now := time.Now()
	reads := &stubReads{byAccount: map[string][]*repository.Ticket{orgA: {ticketIn("t2", orgA, now), ticketIn("t1", orgA, now.Add(-time.Hour))}}}
	a := &memberAuthz{allowed: map[string]bool{"fin|" + orgA: true}}
	svc := newServer(t, &stubRepo{}, reads, a)
	q := `{ eventsByAccount(accountId: "` + orgA + `", first: 1) { edges { node { id } cursor } pageInfo { hasNextPage endCursor } } }`

	got := run(t, svc, "fin", "", q)
	require.Empty(t, got.Errors)
	var data struct {
		EventsByAccount struct {
			Edges    []struct{ Node struct{ ID string } }
			PageInfo struct{ HasNextPage bool }
		}
	}
	require.NoError(t, json.Unmarshal(got.Data, &data))
	require.Len(t, data.EventsByAccount.Edges, 1)
	assert.Equal(t, "t2", data.EventsByAccount.Edges[0].Node.ID)
	assert.True(t, data.EventsByAccount.PageInfo.HasNextPage, "a second event exists beyond the page size")

	denied := run(t, svc, "mallory", orgA, q)
	require.NotEmpty(t, denied.Errors)
	assert.Contains(t, denied.Errors[0].Message, "not authorised")
	assert.JSONEq(t, "null", string(denied.Data))
}

func TestEventHistory_ShouldReturnEntriesNewestFirstToMembersOnly(t *testing.T) {
	now := time.Now().UTC()
	repo := &stubRepo{tickets: map[string]*repository.Ticket{"t1": ticketIn("t1", orgA, now)}}
	reads := &stubReads{history: []repository.AuditRecord{
		{ID: "e2", Entry: audit.Entry{At: now, ActorUserID: "mgr", ActorAccountID: orgA, Action: "event.edit", After: map[string]any{"title": "New"}, Before: map[string]any{"title": "Old"}}},
		{ID: "e1", Entry: audit.Entry{At: now.Add(-time.Hour), ActorUserID: "mgr", Action: "event.create"}},
	}}
	svc := newServer(t, repo, reads, &memberAuthz{allowed: map[string]bool{"mgr|" + orgA: true}})
	q := `{ eventHistory(eventId: "t1") { edges { node { id action actorUserId actorAccountId before after } } pageInfo { hasNextPage } } }`

	got := run(t, svc, "mgr", "", q)

	require.Empty(t, got.Errors)
	var data struct {
		EventHistory struct {
			Edges []struct {
				Node struct {
					ID, Action, ActorUserID       string
					ActorAccountID, Before, After *string
				}
			}
		}
	}
	require.NoError(t, json.Unmarshal(got.Data, &data))
	require.Len(t, data.EventHistory.Edges, 2)
	assert.Equal(t, "e2", data.EventHistory.Edges[0].Node.ID)
	assert.Equal(t, "event.edit", data.EventHistory.Edges[0].Node.Action)
	assert.JSONEq(t, `{"title":"New"}`, *data.EventHistory.Edges[0].Node.After)
	assert.JSONEq(t, `{"title":"Old"}`, *data.EventHistory.Edges[0].Node.Before)
	assert.Nil(t, data.EventHistory.Edges[1].Node.ActorAccountID)

	denied := run(t, svc, "mallory", orgB, q)
	require.NotEmpty(t, denied.Errors)
}

func TestUpdateTicket_ShouldUseTheActingAccountHeaderFromTheRequest(t *testing.T) {
	repo := &stubRepo{tickets: map[string]*repository.Ticket{"t1": ticketIn("t1", orgA, time.Now())}}
	svc := newServer(t, repo, &stubReads{}, &memberAuthz{allowed: map[string]bool{"mgr|" + orgA: true}})
	m := `mutation { updateTicket(id: "t1", input: {title: "Renamed"}) { title } }`

	ok := run(t, svc, "mgr", orgA, m)
	assert.Empty(t, ok.Errors)

	noAccount := run(t, svc, "mgr", "", m)
	require.NotEmpty(t, noAccount.Errors)
	assert.Contains(t, noAccount.Errors[0].Message, "choose an organizer account")
}

func TestBuyerQueries_ShouldNeverCallThePermissionService(t *testing.T) {
	repo := &stubRepo{tickets: map[string]*repository.Ticket{"t1": ticketIn("t1", orgA, time.Now())}}
	a := &memberAuthz{}
	svc := newServer(t, repo, &stubReads{}, a)

	for _, q := range []string{
		`{ ticket(id: "t1") { id title } }`,
		`{ ticketsConnection(first: 5) { edges { node { id } } } }`,
		`{ tickets { id } }`,
	} {
		got := run(t, svc, "buyer", "", q)
		assert.Empty(t, got.Errors, q)
	}
	assert.EqualValues(t, 0, a.calls.Load(), "browsing must work when the permission service is down")
}
