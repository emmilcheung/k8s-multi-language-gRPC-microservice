package service_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/acme/ticket-service/internal/audit"
	"github.com/acme/ticket-service/internal/authz"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/security"
	"github.com/acme/ticket-service/internal/service"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

const (
	acctA = "11111111-1111-4111-8111-111111111111"
	acctB = "22222222-2222-4222-8222-222222222222"
)

// rolePermissions is the slice of the permission table these tests rely on.
var rolePermissions = map[string][]string{
	"EVENT_MANAGER": {"event.create", "event.edit", "event.view"},
	"FINANCE":       {"event.view"},
}

// fakeAuthz answers like user-service: membership of the scope's account
// decides, and the acting account header never matters. It behaves like the
// real client in log mode (always allows, real reason in Reason).
type fakeAuthz struct {
	mode        authz.Mode
	members     map[string]string // userID|accountID -> role
	unavailable bool

	mu    sync.Mutex
	calls []authzCall
}

type authzCall struct {
	Permission string
	Scope      authz.Scope
}

func (f *fakeAuthz) Check(_ context.Context, caller security.TrustedCaller, perm string, scope authz.Scope) (authz.Decision, error) {
	f.mu.Lock()
	f.calls = append(f.calls, authzCall{perm, scope})
	f.mu.Unlock()
	if f.unavailable {
		if f.mode == authz.ModeOn {
			return authz.Decision{Reason: authz.ReasonUnavailable}, authz.ErrAuthzUnavailable
		}
		return authz.Decision{Allowed: true, Reason: authz.ReasonUnavailable}, nil
	}
	d := authz.Decision{Reason: authz.ReasonNotMember}
	if role, ok := f.members[caller.UserID+"|"+scope.AccountID]; ok {
		d.Reason = authz.ReasonRoleLacksPermission
		for _, p := range rolePermissions[role] {
			if p == perm {
				d = authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}
			}
		}
	}
	if f.mode == authz.ModeLog {
		return authz.Decision{Allowed: true, Reason: d.Reason}, nil
	}
	return d, nil
}

func (f *fakeAuthz) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type fakeAccountReads struct {
	byAccount map[string][]*repository.Ticket
	history   map[string][]repository.AuditRecord
}

func (f *fakeAccountReads) FindByAccount(_ context.Context, accountID string, limit int, _ string) ([]*repository.Ticket, error) {
	out := f.byAccount[accountID]
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeAccountReads) ListAuditByResource(_ context.Context, resource string, limit int, _ string) ([]repository.AuditRecord, error) {
	out := f.history[resource]
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func svcWithAuthz(repo repository.TicketRepository, mode authz.Mode, f *fakeAuthz) (*service.TicketService, *observer.ObservedLogs) {
	core, logs := observer.New(zap.WarnLevel)
	f.mode = mode
	svc := service.NewTicketService(repo, &mockPublisher{}, zap.New(core), &mockVenueClient{}, newMockSavedEventRepo())
	svc.WithAuthz(f, mode)
	return svc, logs
}

func seedTicket(repo *mockRepo, id, owner, account string) *repository.Ticket {
	t := &repository.Ticket{ID: id, Title: "Gala", Price: "10.00", UserID: owner, AccountID: account, Version: 1}
	repo.tickets[id] = t
	return t
}

func updateAs(userID, acting string) service.UpdateTicketInput {
	return service.UpdateTicketInput{
		ID: "t1", Title: "Gala 2", Price: "12.00", UserID: userID,
		Caller: security.TrustedCaller{UserID: userID}, ActingAccountID: acting,
	}
}

func TestUpdateTicket_ShouldAllowEventManagerOfTheAccount_WhenEnforced(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{members: map[string]string{"mgr|" + acctA: "EVENT_MANAGER"}})

	got, err := svc.UpdateTicket(context.Background(), updateAs("mgr", acctA))

	require.NoError(t, err)
	assert.Equal(t, "Gala 2", got.Title)
}

func TestUpdateTicket_ShouldRefuseFinanceMember_WhenEnforced(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{members: map[string]string{"fin|" + acctA: "FINANCE"}})

	_, err := svc.UpdateTicket(context.Background(), updateAs("fin", acctA))

	assert.ErrorIs(t, err, service.ErrUnauthorized)
	assert.Equal(t, "Gala", repo.tickets["t1"].Title, "a refused edit must not change the event")
}

func TestUpdateTicket_ShouldRefuseMemberOfAnotherAccount_EvenWithForgedActingAccount(t *testing.T) {
	members := map[string]string{"mallory|" + acctB: "EVENT_MANAGER"}
	for _, acting := range []string{acctA, acctB} {
		repo := newMockRepo()
		seedTicket(repo, "t1", "creator", acctA)
		svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{members: members})

		_, err := svc.UpdateTicket(context.Background(), updateAs("mallory", acting))

		assert.ErrorIs(t, err, service.ErrUnauthorized, "acting account %s must not grant access to account A's event", acting)
		assert.Equal(t, "Gala", repo.tickets["t1"].Title)
	}
}

func TestUpdateTicket_ShouldAskToChooseAnAccount_WhenEnforcedAndHeaderMissing(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "mgr", acctA)
	f := &fakeAuthz{members: map[string]string{"mgr|" + acctA: "EVENT_MANAGER"}}
	svc, _ := svcWithAuthz(repo, authz.ModeOn, f)

	_, err := svc.UpdateTicket(context.Background(), updateAs("mgr", ""))

	assert.ErrorIs(t, err, service.ErrActingAccountRequired)
	assert.Equal(t, 0, f.callCount())
}

func TestUpdateTicket_ShouldRejectActingAccountThatIsNotAnId(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "mgr", acctA)
	f := &fakeAuthz{}
	svc, _ := svcWithAuthz(repo, authz.ModeOn, f)

	_, err := svc.UpdateTicket(context.Background(), updateAs("mgr", "not-an-id; drop"))

	assert.ErrorIs(t, err, service.ErrActingAccountInvalid)
	assert.Equal(t, 0, f.callCount())
}

func TestUpdateTicket_ShouldFailClosed_WhenPermissionServiceIsDownAndEnforced(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "mgr", acctA)
	svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{unavailable: true})

	_, err := svc.UpdateTicket(context.Background(), updateAs("mgr", acctA))

	assert.ErrorIs(t, err, authz.ErrAuthzUnavailable)
	assert.Equal(t, "Gala", repo.tickets["t1"].Title)
}

func TestUpdateTicket_ShouldRefuseTicketWithoutAccount_WhenEnforced(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "mgr", "")
	svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{members: map[string]string{"mgr|" + acctA: "EVENT_MANAGER"}})

	_, err := svc.UpdateTicket(context.Background(), updateAs("mgr", acctA))

	assert.ErrorIs(t, err, service.ErrUnauthorized, "an event nobody has claimed for an account cannot be proven editable")
}

func TestUpdateTicket_ShouldLetTheOldOwnerCheckDecide_WhenLogging(t *testing.T) {
	// The creator is no member of anything (new check would deny); another
	// user is an event manager (new check would allow). The old rule wins.
	f := &fakeAuthz{members: map[string]string{"mgr|" + acctA: "EVENT_MANAGER"}}

	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc, _ := svcWithAuthz(repo, authz.ModeLog, f)
	_, err := svc.UpdateTicket(context.Background(), updateAs("creator", acctA))
	assert.NoError(t, err, "the creator keeps access while only logging")

	repo = newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc, _ = svcWithAuthz(repo, authz.ModeLog, f)
	_, err = svc.UpdateTicket(context.Background(), updateAs("mgr", acctA))
	assert.ErrorIs(t, err, service.ErrUnauthorized, "a member who is not the creator stays refused until enforcement")
}

func disagreements(t *testing.T) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)
	var total float64
	for _, mf := range families {
		if mf.GetName() == "ticket_authz_disagreements_total" {
			for _, m := range mf.GetMetric() {
				total += m.GetCounter().GetValue()
			}
		}
	}
	return total
}

func TestUpdateTicket_ShouldRecordDisagreement_WhenOldAndNewChecksDiffer(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc, logs := svcWithAuthz(repo, authz.ModeLog, &fakeAuthz{})
	before := disagreements(t)

	_, err := svc.UpdateTicket(context.Background(), updateAs("creator", acctA))

	require.NoError(t, err)
	assert.Equal(t, before+1, disagreements(t))
	assert.Equal(t, 1, logs.FilterMessage("authz disagrees with the owner check").Len())
}

func TestUpdateTicket_ShouldNotRecordDisagreement_WhenChecksAgree(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "mgr", acctA)
	svc, logs := svcWithAuthz(repo, authz.ModeLog, &fakeAuthz{members: map[string]string{"mgr|" + acctA: "EVENT_MANAGER"}})
	before := disagreements(t)

	_, err := svc.UpdateTicket(context.Background(), updateAs("mgr", acctA))

	require.NoError(t, err)
	assert.Equal(t, before, disagreements(t))
	assert.Equal(t, 0, logs.Len())
}

func TestUpdateTicket_ShouldFallBackToTicketAccount_WhenLoggingWithoutHeader(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	f := &fakeAuthz{}
	svc, _ := svcWithAuthz(repo, authz.ModeLog, f)

	_, err := svc.UpdateTicket(context.Background(), updateAs("creator", ""))

	require.NoError(t, err, "existing clients that send no account header keep working")
	require.Equal(t, 1, f.callCount())
	assert.Equal(t, acctA, f.calls[0].Scope.AccountID, "the check runs against the event's own account")
}

func TestUpdateTicket_ShouldNotCallPermissionServiceForLegacyTicketWithoutAccount_WhenLoggingWithoutHeader(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", "")
	f := &fakeAuthz{}
	svc, _ := svcWithAuthz(repo, authz.ModeLog, f)

	_, err := svc.UpdateTicket(context.Background(), updateAs("creator", ""))

	require.NoError(t, err)
	assert.Equal(t, 0, f.callCount(), "there is no account to ask about")
}

func TestUpdateTicket_ShouldKeepOldOwnerCheckWithoutAuthz_WhenNotConfigured(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc := newSvc(repo, &mockPublisher{})

	_, err := svc.UpdateTicket(context.Background(), updateAs("stranger", ""))

	assert.ErrorIs(t, err, service.ErrUnauthorized)
}

func TestUpdateTicket_ShouldAuditOnlyTheChangedFields(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "mgr", acctA)
	svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{members: map[string]string{"mgr|" + acctA: "EVENT_MANAGER"}})
	in := updateAs("mgr", acctA)
	in.Price = "10.00" // unchanged

	got, err := svc.UpdateTicket(context.Background(), in)

	require.NoError(t, err)
	require.Len(t, got.Outbox, 1)
	entry := got.Outbox[0].Audit
	require.NotNil(t, entry, "every checked write leaves a history entry")
	assert.Equal(t, "mgr", entry.ActorUserID)
	assert.Equal(t, acctA, entry.ActorAccountID)
	assert.Equal(t, "event.edit", entry.Action)
	assert.Equal(t, "ticket:t1", entry.Resource)
	assert.Equal(t, map[string]any{"title": "Gala"}, entry.Before)
	assert.Equal(t, map[string]any{"title": "Gala 2"}, entry.After)
}

func createAs(userID, acting string) service.CreateTicketInput {
	return service.CreateTicketInput{
		Title: "New show", Price: "20.00", UserID: userID,
		Caller: security.TrustedCaller{UserID: userID}, ActingAccountID: acting,
	}
}

func TestCreateTicket_ShouldOwnTheEventByTheActingAccount_WhenAllowed(t *testing.T) {
	repo := newMockRepo()
	f := &fakeAuthz{members: map[string]string{"mgr|" + acctA: "EVENT_MANAGER"}}
	svc, _ := svcWithAuthz(repo, authz.ModeOn, f)

	got, err := svc.CreateTicket(context.Background(), createAs("mgr", acctA))

	require.NoError(t, err)
	assert.Equal(t, acctA, got.AccountID)
	assert.Equal(t, "mgr", got.UserID, "the user stays recorded as the creator")
	assert.Equal(t, authzCall{"event.create", authz.Scope{AccountID: acctA}}, f.calls[0])
	require.NotNil(t, got.Outbox[0].Audit)
	assert.Equal(t, "event.create", got.Outbox[0].Audit.Action)
	assert.Equal(t, acctA, got.Outbox[0].Audit.ActorAccountID)
}

func TestCreateTicket_ShouldRefuseFinanceMember_WhenEnforced(t *testing.T) {
	repo := newMockRepo()
	svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{members: map[string]string{"fin|" + acctA: "FINANCE"}})

	_, err := svc.CreateTicket(context.Background(), createAs("fin", acctA))

	assert.ErrorIs(t, err, service.ErrUnauthorized)
	assert.Empty(t, repo.tickets)
}

func TestCreateTicket_ShouldAskToChooseAnAccount_WhenEnforcedAndHeaderMissing(t *testing.T) {
	svc, _ := svcWithAuthz(newMockRepo(), authz.ModeOn, &fakeAuthz{})

	_, err := svc.CreateTicket(context.Background(), createAs("mgr", ""))

	assert.ErrorIs(t, err, service.ErrActingAccountRequired)
}

func TestCreateTicket_ShouldNotClaimAnAccountTheCallerIsNotMemberOf_WhenLogging(t *testing.T) {
	repo := newMockRepo()
	svc, _ := svcWithAuthz(repo, authz.ModeLog, &fakeAuthz{})

	got, err := svc.CreateTicket(context.Background(), createAs("outsider", acctA))

	require.NoError(t, err, "logging mode never blocks")
	assert.Empty(t, got.AccountID, "a forged header must not put an event into someone else's account")
}

func TestCreateTicket_ShouldLeaveAccountUnset_WhenLoggingWithoutHeader(t *testing.T) {
	f := &fakeAuthz{}
	svc, _ := svcWithAuthz(newMockRepo(), authz.ModeLog, f)

	got, err := svc.CreateTicket(context.Background(), createAs("anyone", ""))

	require.NoError(t, err)
	assert.Empty(t, got.AccountID)
	assert.Equal(t, 0, f.callCount())
}

func TestBuyerReads_ShouldNeverCallThePermissionService(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	f := &fakeAuthz{}
	svc, _ := svcWithAuthz(repo, authz.ModeOn, f)
	ctx := context.Background()

	_, err := svc.GetTicketByID(ctx, "t1")
	require.NoError(t, err)
	_, err = svc.GetTicketsByIDs(ctx, []string{"t1"})
	require.NoError(t, err)
	_, err = svc.ListTickets(ctx, repository.PaginationParams{})
	require.NoError(t, err)
	_, err = svc.SaveEvent(ctx, "buyer", "t1")
	require.NoError(t, err)
	_, err = svc.IsSaved(ctx, "buyer", "t1")
	require.NoError(t, err)
	_, err = svc.ListSavedEvents(ctx, "buyer", "", 10)
	require.NoError(t, err)
	require.NoError(t, svc.UnsaveEvent(ctx, "buyer", "t1"))

	assert.Equal(t, 0, f.callCount(), "browsing and saving events must work when the permission service is down")
}

func TestEventsByAccount_ShouldListForMembersWhoMayViewEvents(t *testing.T) {
	reads := &fakeAccountReads{byAccount: map[string][]*repository.Ticket{acctA: {{ID: "t1"}, {ID: "t2"}}}}
	f := &fakeAuthz{members: map[string]string{"fin|" + acctA: "FINANCE"}}
	svc, _ := svcWithAuthz(newMockRepo(), authz.ModeOn, f)
	svc.WithAccountReads(reads)

	got, err := svc.EventsByAccount(context.Background(), security.TrustedCaller{UserID: "fin"}, acctA, 10, "")

	require.NoError(t, err)
	assert.Len(t, got, 2)
	assert.Equal(t, authzCall{"event.view", authz.Scope{AccountID: acctA}}, f.calls[0])
}

func TestEventsByAccount_ShouldRefuseNonMembers_WhenEnforced(t *testing.T) {
	reads := &fakeAccountReads{byAccount: map[string][]*repository.Ticket{acctA: {{ID: "t1"}}}}
	svc, _ := svcWithAuthz(newMockRepo(), authz.ModeOn, &fakeAuthz{members: map[string]string{"mallory|" + acctB: "EVENT_MANAGER"}})
	svc.WithAccountReads(reads)

	_, err := svc.EventsByAccount(context.Background(), security.TrustedCaller{UserID: "mallory"}, acctA, 10, "")

	assert.ErrorIs(t, err, service.ErrUnauthorized)
}

func TestEventsByAccount_ShouldRefuseAnonymousCallers(t *testing.T) {
	svc, _ := svcWithAuthz(newMockRepo(), authz.ModeLog, &fakeAuthz{})
	svc.WithAccountReads(&fakeAccountReads{})

	_, err := svc.EventsByAccount(context.Background(), security.TrustedCaller{}, acctA, 10, "")

	assert.ErrorIs(t, err, service.ErrUnauthorized)
}

func TestEventHistory_ShouldCheckViewOnTheEventsOwnAccountAndReturnEntries(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	newest := repository.AuditRecord{ID: "e2", Entry: audit.Entry{At: time.Now(), Action: "event.edit"}}
	oldest := repository.AuditRecord{ID: "e1", Entry: audit.Entry{At: time.Now().Add(-time.Hour), Action: "event.create"}}
	reads := &fakeAccountReads{history: map[string][]repository.AuditRecord{"ticket:t1": {newest, oldest}}}
	f := &fakeAuthz{members: map[string]string{"fin|" + acctA: "FINANCE"}}
	svc, _ := svcWithAuthz(repo, authz.ModeOn, f)
	svc.WithAccountReads(reads)

	got, err := svc.EventHistory(context.Background(), security.TrustedCaller{UserID: "fin"}, "t1", 10, "")

	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "e2", got[0].ID, "newest first")
	assert.Equal(t, authzCall{"event.view", authz.Scope{AccountID: acctA}}, f.calls[0])
}

func TestEventHistory_ShouldRefuseMemberOfAnotherAccount_WhenEnforced(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc, _ := svcWithAuthz(repo, authz.ModeOn, &fakeAuthz{members: map[string]string{"mallory|" + acctB: "EVENT_MANAGER"}})
	svc.WithAccountReads(&fakeAccountReads{history: map[string][]repository.AuditRecord{"ticket:t1": {{ID: "e1"}}}})

	_, err := svc.EventHistory(context.Background(), security.TrustedCaller{UserID: "mallory"}, "t1", 10, "")

	assert.ErrorIs(t, err, service.ErrUnauthorized)
}

func TestEventHistory_ShouldLetOnlyTheCreatorReadWhileLogging(t *testing.T) {
	repo := newMockRepo()
	seedTicket(repo, "t1", "creator", acctA)
	svc, _ := svcWithAuthz(repo, authz.ModeLog, &fakeAuthz{})
	svc.WithAccountReads(&fakeAccountReads{history: map[string][]repository.AuditRecord{"ticket:t1": {{ID: "e1"}}}})

	_, err := svc.EventHistory(context.Background(), security.TrustedCaller{UserID: "creator"}, "t1", 10, "")
	assert.NoError(t, err)
	_, err = svc.EventHistory(context.Background(), security.TrustedCaller{UserID: "other"}, "t1", 10, "")
	assert.ErrorIs(t, err, service.ErrUnauthorized)
}

func TestEventHistory_ShouldReportNotFound_WhenEventIsUnknown(t *testing.T) {
	svc, _ := svcWithAuthz(newMockRepo(), authz.ModeOn, &fakeAuthz{})
	svc.WithAccountReads(&fakeAccountReads{})

	_, err := svc.EventHistory(context.Background(), security.TrustedCaller{UserID: "x"}, "nope", 10, "")

	assert.True(t, errors.Is(err, repository.ErrTicketNotFound))
}
