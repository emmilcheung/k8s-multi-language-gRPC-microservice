package service

import (
	"context"
	"errors"
	"testing"

	"github.com/acme/venue-service/internal/audit"
	"github.com/acme/venue-service/internal/authz"
	"github.com/acme/venue-service/internal/repository"
	"github.com/acme/venue-service/internal/security"
	"github.com/jackc/pgx/v5"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	acctCreator = "11111111-1111-1111-1111-111111111111"
	acctOther   = "22222222-2222-2222-2222-222222222222"
	acctTeam    = "33333333-3333-3333-3333-333333333333"
)

// fakeUserService answers like user-service would: platform staff pass
// everything, otherwise a (user, permission, scope) must be on the allow list.
type fakeUserService struct {
	allow map[string]bool
	err   error
	calls []string
}

func key(user, perm, account, venue string) string {
	return user + "|" + perm + "|" + account + "|" + venue
}

func (f *fakeUserService) Check(_ context.Context, c security.TrustedCaller, perm string, s authz.Scope) (authz.Decision, error) {
	f.calls = append(f.calls, perm)
	if f.err != nil {
		return authz.Decision{Reason: authz.ReasonUnavailable}, f.err
	}
	if len(c.PlatformRoles) > 0 || f.allow[key(c.UserID, perm, s.AccountID, s.VenueID)] {
		return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
	}
	return authz.Decision{Reason: authz.ReasonNotMember}, nil
}

type fakeTickets struct {
	account string
	err     error
	calls   int
}

func (f *fakeTickets) GetTicket(_ context.Context, _ *ticketsv1.GetTicketRequest, _ ...grpc.CallOption) (*ticketsv1.GetTicketResponse, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &ticketsv1.GetTicketResponse{AccountId: f.account}, nil
}

type fakeTx struct{}

func (fakeTx) InTx(ctx context.Context, fn func(context.Context, pgx.Tx) error) error {
	return fn(ctx, nil)
}

func newAccess(mode authz.Mode, us *fakeUserService, tk *fakeTickets) (*OrganizerAccess, *[]audit.Entry) {
	a := NewOrganizerAccess(us, mode, tk, fakeTx{}, zap.NewNop())
	var entries []audit.Entry
	a.record = func(_ context.Context, _ pgx.Tx, e audit.Entry) error {
		entries = append(entries, e)
		return nil
	}
	return a, &entries
}

var (
	creator = security.TrustedCaller{UserID: "user-creator"}
	admin   = security.TrustedCaller{UserID: "user-admin", PlatformRoles: []string{security.RolePlatformAdmin}}
)

func unverifiedVenue() *repository.Venue {
	return &repository.Venue{ID: "venue-1", OrganizerID: "user-creator", Status: repository.VenueStatusUnverified, CreatedByAccountID: acctCreator}
}

func verifiedVenue() *repository.Venue {
	v := unverifiedVenue()
	v.Status = repository.VenueStatusVerified
	return v
}

// An unverified venue is a draft of the account that made it: the account's
// organizers may edit it, nobody else, and a header naming a different account
// must not grant access, because ownership comes from the stored venue.
func TestVenueEdit_AnUnverifiedVenueIsEditableByItsCreatorAccount(t *testing.T) {
	us := &fakeUserService{allow: map[string]bool{
		key("user-creator", permVenueCreate, acctCreator, ""): true,
		key("user-creator", permVenueCreate, acctOther, ""):   true, // member of both accounts
	}}
	a, _ := newAccess(authz.ModeOn, us, &fakeTickets{})
	ctx := context.Background()

	acct, err := a.AuthorizeVenueEdit(ctx, creator, acctCreator, unverifiedVenue())
	require.NoError(t, err)
	assert.Equal(t, acctCreator, acct, "the audit trail names the account that was checked")

	_, err = a.AuthorizeVenueEdit(ctx, creator, acctOther, unverifiedVenue())
	assert.ErrorIs(t, err, ErrUnauthorized, "a caller's other account must not edit this venue")

	_, err = a.AuthorizeVenueEdit(ctx, creator, "", unverifiedVenue())
	assert.ErrorIs(t, err, ErrActingAccountRequired)

	_, err = a.AuthorizeVenueEdit(ctx, security.TrustedCaller{UserID: "stranger"}, acctCreator, unverifiedVenue())
	assert.ErrorIs(t, err, ErrUnauthorized, "not a member of the creator account")

	_, err = a.AuthorizeVenueEdit(ctx, admin, "", unverifiedVenue())
	assert.NoError(t, err, "platform admin is decided by user-service")
}

// Once verified, the venue is run by its venue team. The creator account's
// organizers no longer hold the pen unless they are on the team.
func TestVenueEdit_AVerifiedVenueIsEditableOnlyByTheVenueTeamOrAPlatformAdmin(t *testing.T) {
	us := &fakeUserService{allow: map[string]bool{
		key("user-creator", permVenueCreate, acctCreator, ""): true,
		key("user-team", permVenueEditProfile, "", "venue-1"): true,
	}}
	a, _ := newAccess(authz.ModeOn, us, &fakeTickets{})
	ctx := context.Background()

	_, err := a.AuthorizeVenueEdit(ctx, security.TrustedCaller{UserID: "user-team"}, acctTeam, verifiedVenue())
	assert.NoError(t, err, "venue team member")

	_, err = a.AuthorizeVenueEdit(ctx, creator, acctCreator, verifiedVenue())
	assert.ErrorIs(t, err, ErrUnauthorized, "creator account owner who is not on the venue team")

	_, err = a.AuthorizeVenueEdit(ctx, admin, "", verifiedVenue())
	assert.NoError(t, err, "platform admin")
}

func TestPlanCreate_NeedsATicketTheAccountMayEditAndAVenueItMayUse(t *testing.T) {
	us := &fakeUserService{allow: map[string]bool{
		key("user-creator", permLayoutCreate, acctCreator, ""): true,
		key("user-creator", permEventEdit, acctCreator, ""):    true,
	}}
	ctx := context.Background()

	t.Run("own ticket, own unverified venue", func(t *testing.T) {
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{account: acctCreator})
		acct, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
		require.NoError(t, err)
		assert.Equal(t, acctCreator, acct)
	})
	t.Run("a verified venue is usable by any account", func(t *testing.T) {
		v := verifiedVenue()
		v.CreatedByAccountID = acctOther
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{account: acctCreator})
		_, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, v, "ticket-1")
		assert.NoError(t, err)
	})
	t.Run("someone else's ticket", func(t *testing.T) {
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{account: acctOther})
		_, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
		assert.ErrorIs(t, err, ErrUnauthorized)
	})
	t.Run("someone else's unverified venue", func(t *testing.T) {
		v := unverifiedVenue()
		v.CreatedByAccountID = acctOther
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{account: acctCreator})
		_, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, v, "ticket-1")
		assert.ErrorIs(t, err, ErrUnauthorized)
	})
	t.Run("ticket without an owning account yet", func(t *testing.T) {
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{account: ""})
		_, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
		assert.ErrorIs(t, err, ErrUnauthorized, "an empty owner must never match the acting account")
	})
	t.Run("missing ticket", func(t *testing.T) {
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{err: status.Error(codes.NotFound, "x")})
		_, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
		assert.ErrorIs(t, err, ErrTicketNotFound)
	})
	t.Run("ticket-service down", func(t *testing.T) {
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{err: status.Error(codes.Unavailable, "x")})
		_, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
		assert.ErrorIs(t, err, ErrTicketLookupUnavailable)
	})
	t.Run("no acting account", func(t *testing.T) {
		a, _ := newAccess(authz.ModeOn, us, &fakeTickets{account: acctCreator})
		_, err := a.AuthorizePlanCreate(ctx, creator, "", unverifiedVenue(), "ticket-1")
		assert.ErrorIs(t, err, ErrActingAccountRequired)
	})
	t.Run("account lacks the layout permission", func(t *testing.T) {
		a, _ := newAccess(authz.ModeOn, &fakeUserService{}, &fakeTickets{account: acctCreator})
		_, err := a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
		assert.ErrorIs(t, err, ErrUnauthorized)
	})
}

func TestPlanEdit_TheAccountMustOwnThePlansTicket(t *testing.T) {
	us := &fakeUserService{allow: map[string]bool{key("user-creator", permLayoutCreate, acctCreator, ""): true}}
	plan := &repository.SeatingPlan{ID: "plan-1", TicketID: "ticket-1", OrganizerID: "someone-who-left"}
	ctx := context.Background()

	a, _ := newAccess(authz.ModeOn, us, &fakeTickets{account: acctCreator})
	_, err := a.AuthorizePlanEdit(ctx, creator, acctCreator, plan)
	assert.NoError(t, err, "a team member who did not create the plan may edit it")

	a, _ = newAccess(authz.ModeOn, us, &fakeTickets{account: acctOther})
	_, err = a.AuthorizePlanEdit(ctx, creator, acctCreator, plan)
	assert.ErrorIs(t, err, ErrUnauthorized)
}

// Logging mode must be invisible to callers: the old creator comparison decides
// and the new answer is only compared.
func TestLogMode_TheOldOwnerCheckStillDecides(t *testing.T) {
	ctx := context.Background()
	deny := &fakeUserService{}
	a, _ := newAccess(authz.ModeLog, deny, &fakeTickets{account: acctOther})

	_, err := a.AuthorizeVenueEdit(ctx, creator, "", unverifiedVenue())
	assert.NoError(t, err, "no acting account is not an error while logging; the creator passes")

	_, err = a.AuthorizeVenueEdit(ctx, security.TrustedCaller{UserID: "stranger"}, "", unverifiedVenue())
	assert.ErrorIs(t, err, ErrUnauthorized, "a stranger is refused exactly as before")

	_, err = a.AuthorizeVenueEdit(ctx, admin, "", unverifiedVenue())
	assert.ErrorIs(t, err, ErrUnauthorized, "log mode does not give platform admins a new bypass")

	_, err = a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
	assert.NoError(t, err, "a plan for someone else's ticket still passes, as before, while only being logged")

	acct, err := a.AuthorizeVenueCreate(ctx, creator, "")
	require.NoError(t, err)
	assert.Empty(t, acct)

	// An authz outage and a rejected request must not become new failures.
	broken := &fakeUserService{err: authz.ErrAuthzUnavailable}
	a, _ = newAccess(authz.ModeLog, broken, &fakeTickets{err: errors.New("down")})
	_, err = a.AuthorizeVenueEdit(ctx, creator, acctCreator, unverifiedVenue())
	assert.NoError(t, err)
	_, err = a.AuthorizePlanCreate(ctx, creator, acctCreator, unverifiedVenue(), "ticket-1")
	assert.NoError(t, err)
}

func TestOffMode_NeverAsksUserService(t *testing.T) {
	us := &fakeUserService{}
	a, entries := newAccess(authz.ModeOff, us, &fakeTickets{})
	_, err := a.AuthorizeVenueEdit(context.Background(), creator, acctCreator, unverifiedVenue())
	require.NoError(t, err)
	_, err = a.AuthorizeVenueCreate(context.Background(), creator, acctCreator)
	require.NoError(t, err)
	require.NoError(t, a.Audited(context.Background(), func() audit.Entry { return audit.Entry{} }, func(context.Context) error { return nil }))
	assert.Empty(t, us.calls)
	assert.Empty(t, *entries, "mode off writes no audit rows")
}

func TestOnMode_VenueCreateNeedsAnActingAccountAndRecordsIt(t *testing.T) {
	us := &fakeUserService{allow: map[string]bool{key("user-creator", permVenueCreate, acctCreator, ""): true}}
	a, _ := newAccess(authz.ModeOn, us, &fakeTickets{})
	ctx := context.Background()

	_, err := a.AuthorizeVenueCreate(ctx, creator, "")
	assert.ErrorIs(t, err, ErrActingAccountRequired)

	acct, err := a.AuthorizeVenueCreate(ctx, creator, acctCreator)
	require.NoError(t, err)
	assert.Equal(t, acctCreator, acct, "the venue records the verified account as its creator")

	_, err = a.AuthorizeVenueCreate(ctx, creator, acctOther)
	assert.ErrorIs(t, err, ErrUnauthorized, "not a member of that account")
}

// Log mode may only credit the venue to an account that user-service vouched
// for; a forged header must not become the venue's owner.
func TestLogMode_VenueCreateOnlyRecordsAVouchedAccount(t *testing.T) {
	us := &fakeUserService{allow: map[string]bool{key("user-creator", permVenueCreate, acctCreator, ""): true}}
	a, _ := newAccess(authz.ModeLog, us, &fakeTickets{})
	ctx := context.Background()

	acct, err := a.AuthorizeVenueCreate(ctx, creator, acctCreator)
	require.NoError(t, err)
	assert.Equal(t, acctCreator, acct)

	acct, err = a.AuthorizeVenueCreate(ctx, creator, acctOther)
	require.NoError(t, err)
	assert.Empty(t, acct)
}

func TestOnMode_AnOutageIs503AndARejectedRequestIsNotAPermissionAnswer(t *testing.T) {
	ctx := context.Background()
	a, _ := newAccess(authz.ModeOn, &fakeUserService{err: authz.ErrAuthzUnavailable}, &fakeTickets{account: acctCreator})
	_, err := a.AuthorizeVenueCreate(ctx, creator, acctCreator)
	assert.ErrorIs(t, err, authz.ErrAuthzUnavailable, "caller maps this to 503")

	a, _ = newAccess(authz.ModeOn, &fakeUserService{err: status.Error(codes.InvalidArgument, "bad")}, &fakeTickets{})
	_, err = a.AuthorizeVenueCreate(ctx, creator, acctCreator)
	assert.ErrorIs(t, err, ErrPermissionCheckFailed, "caller maps this to 500")
	assert.NotErrorIs(t, err, ErrUnauthorized)
}

func TestActingAccount_OnlyEnforcementRejectsAMalformedSelector(t *testing.T) {
	on, _ := newAccess(authz.ModeOn, &fakeUserService{}, nil)
	_, err := on.ActingAccount("not-a-uuid")
	assert.ErrorIs(t, err, ErrActingAccountInvalid)

	log, _ := newAccess(authz.ModeLog, &fakeUserService{}, nil)
	got, err := log.ActingAccount("not-a-uuid")
	assert.NoError(t, err)
	assert.Empty(t, got)
}

func TestAudited_TheChangeAndItsAuditRowSucceedOrFailTogether(t *testing.T) {
	a, entries := newAccess(authz.ModeOn, &fakeUserService{}, nil)
	ctx := context.Background()
	build := func() audit.Entry { return audit.Entry{ActorUserID: "u", Action: "x", Resource: "y"} }

	changeErr := errors.New("change failed")
	err := a.Audited(ctx, build, func(context.Context) error { return changeErr })
	assert.ErrorIs(t, err, changeErr)
	assert.Empty(t, *entries, "no audit row for a change that did not happen")

	recordErr := errors.New("audit failed")
	a.record = func(context.Context, pgx.Tx, audit.Entry) error { return recordErr }
	err = a.Audited(ctx, build, func(context.Context) error { return nil })
	assert.ErrorIs(t, err, recordErr, "a failed audit write fails the change so the transaction rolls back")
}

func TestChangeEntry_RecordsOnlyTheFieldsThatChanged(t *testing.T) {
	before := map[string]any{"name": "Old", "capacity": 100, "timezone": "UTC"}
	after := map[string]any{"name": "New", "capacity": 100, "timezone": "UTC"}
	e := ChangeEntry(context.Background(), "u", "acct", ActionVenueUpdate, "venue:1", before, after)
	assert.Equal(t, map[string]any{"name": "Old"}, e.Before)
	assert.Equal(t, map[string]any{"name": "New"}, e.After)
	assert.Equal(t, "acct", e.ActorAccountID)

	created := ChangeEntry(context.Background(), "u", "", ActionVenueCreate, "venue:1", nil, after)
	assert.Nil(t, created.Before)
	assert.Len(t, created.After, 3)
}
