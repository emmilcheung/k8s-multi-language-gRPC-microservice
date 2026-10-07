package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/audit"
	"github.com/acme/attendance-service/internal/authz"
	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/security"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

const (
	acctA   = "11111111-1111-1111-1111-111111111111"
	acctB   = "22222222-2222-2222-2222-222222222222"
	eventX  = "ticket-x"
	eventY  = "ticket-y"
	ownerID = "owner-user"
)

type member struct {
	account string
	role    string
	events  []string // door staff limited to these events; empty means all
}

// fakeAuthz applies the docs permission table for the three permissions the
// attendance service asks about.
type fakeAuthz struct {
	members map[string]member
	err     error
	asked   []authz.Scope
}

func (f *fakeAuthz) Check(_ context.Context, caller security.TrustedCaller, perm string, scope authz.Scope) (authz.Decision, error) {
	f.asked = append(f.asked, scope)
	if f.err != nil {
		return authz.Decision{Reason: authz.ReasonUnavailable}, f.err
	}
	m, ok := f.members[caller.UserID]
	if !ok || m.account != scope.AccountID {
		return authz.Decision{Reason: authz.ReasonNotMember}, nil
	}
	switch m.role {
	case "OWNER", "ADMIN", "EVENT_MANAGER":
		return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
	case "FINANCE":
		if perm == PermEventView {
			return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
		}
	case "DOOR_STAFF":
		if perm == PermAttendanceScan || perm == PermEventView {
			if len(m.events) > 0 {
				for _, e := range m.events {
					if e == scope.EventID {
						return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
					}
				}
				return authz.Decision{Reason: authz.ReasonOutOfScope}, nil
			}
			return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
		}
	}
	return authz.Decision{Reason: authz.ReasonRoleLacksPermission}, nil
}

type fakeTickets struct {
	owners map[string]TicketOwner
	err    error
}

func (f fakeTickets) LookupTicketOwnership(_ context.Context, id string) (TicketOwner, error) {
	if f.err != nil {
		return TicketOwner{}, f.err
	}
	o, ok := f.owners[id]
	if !ok {
		return TicketOwner{}, repository.ErrNotFound
	}
	return o, nil
}

type fakeTokens struct{ events map[string]string }

// VerifySigned returns claims for any token whose signature is good, expired
// or not; "forged" and unknown tokens fail the signature.
func (f fakeTokens) VerifySigned(token string) (*qr.Claims, error) {
	e, ok := f.events[token]
	if !ok {
		return nil, qr.ErrTokenInvalid
	}
	return &qr.Claims{EventID: e}, nil
}

func newAccess(mode authz.Mode, a *fakeAuthz) *OrganizerAccess {
	tickets := fakeTickets{owners: map[string]TicketOwner{
		eventX: {UserID: ownerID, AccountID: acctA},
		eventY: {UserID: ownerID, AccountID: acctA},
	}}
	tokens := fakeTokens{events: map[string]string{"token-x": eventX, "token-y": eventY, "token-expired-x": eventX}}
	return NewOrganizerAccess(a, mode, tickets, tokens, nil, nil, zap.NewNop())
}

func staff(role string, events ...string) member {
	return member{account: acctA, role: role, events: events}
}

func TestDoorStaffLimitedToOneEventCanScanThatEventAndNotAnother(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"door": staff("DOOR_STAFF", eventX)}}
	access := newAccess(authz.ModeOn, a)
	caller := security.TrustedCaller{UserID: "door"}

	_, err := access.AuthorizeEvent(context.Background(), caller, acctA, PermAttendanceScan, eventX, true)
	require.NoError(t, err)

	_, err = access.AuthorizeEvent(context.Background(), caller, acctA, PermAttendanceScan, eventY, true)
	assert.ErrorIs(t, err, ErrForbidden)
	assert.Equal(t, authz.Scope{AccountID: acctA, EventID: eventY}, a.asked[len(a.asked)-1],
		"the event id must be sent so the permission service can tell out-of-scope from allowed")
}

func TestFinanceCannotScan(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"fin": staff("FINANCE")}}
	_, err := newAccess(authz.ModeOn, a).AuthorizeEvent(context.Background(),
		security.TrustedCaller{UserID: "fin"}, acctA, PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, ErrForbidden)
}

func TestAnAccountMemberWhoIsNotTheTicketCreatorCanScanWhenEnforcing(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"mgr": staff("EVENT_MANAGER")}}
	acct, err := newAccess(authz.ModeOn, a).AuthorizeEvent(context.Background(),
		security.TrustedCaller{UserID: "mgr"}, acctA, PermAttendanceScan, eventX, true)
	require.NoError(t, err)
	assert.Equal(t, acctA, acct, "the verified account is what the audit row names")
}

func TestValidateScanIsDeniedForNonMembers(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"door": staff("DOOR_STAFF", eventX)}}
	access := newAccess(authz.ModeOn, a)

	_, err := access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "stranger"}, acctA, "token-x")
	assert.ErrorIs(t, err, ErrForbidden)

	_, err = access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "door"}, acctA, "token-x")
	assert.NoError(t, err)

	_, err = access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "door"}, acctA, "token-y")
	assert.ErrorIs(t, err, ErrForbidden, "door staff limited to X cannot validate a pass for Y")
}

func TestValidateScanWithATokenWhoseSignatureFailsIsRefusedWithoutAnyCheckWhenEnforcing(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"mgr": staff("EVENT_MANAGER")}}
	_, err := newAccess(authz.ModeOn, a).AuthorizeScanToken(context.Background(),
		security.TrustedCaller{UserID: "mgr"}, acctA, "forged")
	assert.ErrorIs(t, err, ErrScanTokenUnverifiable,
		"no trustworthy event, so the caller cannot be scoped and no scan row may be written")
	assert.Empty(t, a.asked)
}

func TestValidateScanWithAnExpiredButCorrectlySignedTokenIsCheckedOnItsEvent(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"door": staff("DOOR_STAFF", eventX), "fin": staff("FINANCE")}}
	access := newAccess(authz.ModeOn, a)

	_, err := access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "door"}, acctA, "token-expired-x")
	require.NoError(t, err, "door staff for the event still reach Validate, which answers valid:false and records the attempt")

	_, err = access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "fin"}, acctA, "token-expired-x")
	assert.ErrorIs(t, err, ErrForbidden)
}

type slowTickets struct{ delay time.Duration }

// LookupTicketOwnership ignores the context on purpose: the bound must hold
// even when a lookup does not honour its deadline.
func (s slowTickets) LookupTicketOwnership(context.Context, string) (TicketOwner, error) {
	time.Sleep(s.delay)
	return TicketOwner{UserID: ownerID, AccountID: acctA}, nil
}

func TestLoggingModeNeverLetsASlowTicketServiceStallAScan(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{}}
	access := NewOrganizerAccess(a, authz.ModeLog, slowTickets{delay: 3 * time.Second},
		fakeTokens{events: map[string]string{"token-x": eventX}}, nil, nil, zap.NewNop())

	start := time.Now()
	_, err := access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "stranger"}, "", "token-x")

	require.NoError(t, err, "log mode never blocks a scan")
	assert.Less(t, time.Since(start), time.Second, "the comparison is cut off at the short log-mode deadline")
}

func TestTheAttendancePolicyEditNeedsEventEdit(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{
		"door": staff("DOOR_STAFF"), "fin": staff("FINANCE"), "mgr": staff("EVENT_MANAGER"),
	}}
	access := newAccess(authz.ModeOn, a)
	for user, wantErr := range map[string]bool{"door": true, "fin": true, "mgr": false} {
		_, err := access.AuthorizeEvent(context.Background(), security.TrustedCaller{UserID: user}, acctA, PermEventEdit, eventX, true)
		assert.Equal(t, wantErr, err != nil, user)
	}
}

func TestEnforcingNeedsAnActingAccountAndItMustBeTheEventsAccount(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"mgr": staff("EVENT_MANAGER")}}
	access := newAccess(authz.ModeOn, a)
	caller := security.TrustedCaller{UserID: "mgr"}

	_, err := access.AuthorizeEvent(context.Background(), caller, "", PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, ErrActingAccountRequired)

	_, err = access.AuthorizeEvent(context.Background(), caller, acctB, PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, ErrForbidden, "the header only selects; the event's own account is what is checked")
	assert.Empty(t, a.asked, "a wrong selector must not reach the permission service")
}

func TestEnforcingFailsClosedWhenThePermissionServiceIsDown(t *testing.T) {
	a := &fakeAuthz{err: authz.ErrAuthzUnavailable}
	_, err := newAccess(authz.ModeOn, a).AuthorizeEvent(context.Background(),
		security.TrustedCaller{UserID: "mgr"}, acctA, PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, authz.ErrAuthzUnavailable)
}

func TestEnforcingTreatsARejectedPermissionRequestAsAServerFault(t *testing.T) {
	a := &fakeAuthz{err: errors.New("authz: user-service rejected the request")}
	_, err := newAccess(authz.ModeOn, a).AuthorizeEvent(context.Background(),
		security.TrustedCaller{UserID: "mgr"}, acctA, PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, ErrPermissionCheckFailed)
}

func TestEnforcingReportsAnUnreachableTicketServiceAsUnavailable(t *testing.T) {
	access := NewOrganizerAccess(&fakeAuthz{}, authz.ModeOn, fakeTickets{err: errors.New("dial")}, nil, nil, nil, zap.NewNop())
	_, err := access.AuthorizeEvent(context.Background(), security.TrustedCaller{UserID: "mgr"}, acctA, PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, ErrTicketLookupUnavailable)
}

func TestLoggingModeKeepsTheOwnerOnlyAnswerAndCountsDisagreements(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{"door": staff("DOOR_STAFF", eventX)}}
	access := newAccess(authz.ModeLog, a)

	// The creator is not a member in the permission service: old rule allows, new would deny.
	before := testutil.ToFloat64(authzDisagreements.WithLabelValues(PermAttendanceScan, "allow", "deny"))
	_, err := access.AuthorizeEvent(context.Background(), security.TrustedCaller{UserID: ownerID}, "", PermAttendanceScan, eventX, true)
	require.NoError(t, err, "logging mode must not change the outcome")
	assert.Equal(t, before+1, testutil.ToFloat64(authzDisagreements.WithLabelValues(PermAttendanceScan, "allow", "deny")))

	// A door staff member who is not the creator: old rule denies, and still does.
	_, err = access.AuthorizeEvent(context.Background(), security.TrustedCaller{UserID: "door"}, "", PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, ErrForbidden)
}

func TestLoggingModeIgnoresTheAccountHeaderAndNeverAsksForOne(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{ownerID: staff("OWNER")}}
	_, err := newAccess(authz.ModeLog, a).AuthorizeEvent(context.Background(),
		security.TrustedCaller{UserID: ownerID}, "", PermEventEdit, eventX, true)
	assert.NoError(t, err)
}

func TestLoggingModeKeepsTheLookupFailureTheOldCheckGave(t *testing.T) {
	boom := errors.New("ticket-service down")
	access := NewOrganizerAccess(&fakeAuthz{}, authz.ModeLog, fakeTickets{err: boom}, nil, nil, nil, zap.NewNop())
	_, err := access.AuthorizeEvent(context.Background(), security.TrustedCaller{UserID: ownerID}, "", PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, boom)
	assert.NotErrorIs(t, err, ErrTicketLookupUnavailable)
}

func TestLoggingModeRecordsAWouldDenyForValidateScanButNeverBlocksIt(t *testing.T) {
	a := &fakeAuthz{members: map[string]member{}}
	access := newAccess(authz.ModeLog, a)
	before := testutil.ToFloat64(authzDisagreements.WithLabelValues(PermAttendanceScan, "allow", "deny"))

	_, err := access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "stranger"}, "", "token-x")

	require.NoError(t, err)
	assert.Len(t, a.asked, 1, "the check still runs so the would-deny is recorded")
	assert.Equal(t, before+1, testutil.ToFloat64(authzDisagreements.WithLabelValues(PermAttendanceScan, "allow", "deny")))
}

func TestOffModeNeverAsksThePermissionServiceAndValidateScanStaysUnchecked(t *testing.T) {
	a := &fakeAuthz{}
	access := newAccess(authz.ModeOff, a)
	_, err := access.AuthorizeScanToken(context.Background(), security.TrustedCaller{UserID: "anyone"}, "", "token-x")
	require.NoError(t, err)
	_, err = access.AuthorizeEvent(context.Background(), security.TrustedCaller{UserID: "anyone"}, "", PermAttendanceScan, eventX, true)
	assert.ErrorIs(t, err, ErrForbidden, "owner-only still applies to the other scan paths")
	assert.Empty(t, a.asked)
}

func TestAnUnknownEventIsNotFoundNotForbidden(t *testing.T) {
	a := &fakeAuthz{}
	_, err := newAccess(authz.ModeOn, a).AuthorizeEvent(context.Background(),
		security.TrustedCaller{UserID: "mgr"}, acctA, PermAttendanceScan, "missing", true)
	assert.ErrorIs(t, err, repository.ErrNotFound)
}

func TestAMalformedAccountHeaderOnlyFailsWhenEnforcing(t *testing.T) {
	_, err := newAccess(authz.ModeOn, &fakeAuthz{}).ActingAccount("not-a-uuid")
	assert.ErrorIs(t, err, ErrActingAccountInvalid)
	acct, err := newAccess(authz.ModeLog, &fakeAuthz{}).ActingAccount("not-a-uuid")
	assert.NoError(t, err)
	assert.Empty(t, acct)
}

type fakeTx struct{ ran bool }

func (f *fakeTx) InTx(ctx context.Context, fn func(ctx context.Context, tx pgx.Tx) error) error {
	f.ran = true
	return fn(ctx, nil)
}

func TestThePolicyEditIsAuditedWithTheVerifiedActorAccountAndOnlyChangedFields(t *testing.T) {
	tx := &fakeTx{}
	access := NewOrganizerAccess(&fakeAuthz{}, authz.ModeOn, nil, nil, tx, nil, zap.NewNop())
	var got []audit.Entry
	access.record = func(_ context.Context, _ pgx.Tx, e audit.Entry) error { got = append(got, e); return nil }

	before := &repository.AttendancePolicy{EventID: eventX, RequireQRForEntry: true, AllowManualOverride: false}
	after := &repository.AttendancePolicy{EventID: eventX, RequireQRForEntry: true, AllowManualOverride: true}
	err := access.Audited(context.Background(),
		func() audit.Entry { return PolicyEditEntry(context.Background(), "mgr", acctA, before, after) },
		func(context.Context) error { return nil })

	require.NoError(t, err)
	require.True(t, tx.ran)
	require.Len(t, got, 1)
	assert.Equal(t, "mgr", got[0].ActorUserID)
	assert.Equal(t, acctA, got[0].ActorAccountID)
	assert.Equal(t, map[string]any{"allowManualOverride": false}, got[0].Before)
	assert.Equal(t, map[string]any{"allowManualOverride": true}, got[0].After)
}

func TestAChangeThatFailsLeavesNoAuditRow(t *testing.T) {
	tx := &fakeTx{}
	access := NewOrganizerAccess(&fakeAuthz{}, authz.ModeOn, nil, nil, tx, nil, zap.NewNop())
	wrote := false
	access.record = func(context.Context, pgx.Tx, audit.Entry) error { wrote = true; return nil }
	boom := errors.New("write failed")

	err := access.Audited(context.Background(), func() audit.Entry { return audit.Entry{} },
		func(context.Context) error { return boom })

	assert.ErrorIs(t, err, boom)
	assert.False(t, wrote)
}

func TestOffModeWritesNoAuditRow(t *testing.T) {
	tx := &fakeTx{}
	access := NewOrganizerAccess(&fakeAuthz{}, authz.ModeOff, nil, nil, tx, nil, zap.NewNop())
	called := false
	err := access.Audited(context.Background(), func() audit.Entry { return audit.Entry{} },
		func(context.Context) error { called = true; return nil })
	require.NoError(t, err)
	assert.True(t, called)
	assert.False(t, tx.ran)
}

func TestAPolicySaveThatChangesNothingWritesNoAuditRow(t *testing.T) {
	tx := &fakeTx{}
	access := NewOrganizerAccess(&fakeAuthz{}, authz.ModeOn, nil, nil, tx, nil, zap.NewNop())
	wrote := false
	access.record = func(context.Context, pgx.Tx, audit.Entry) error { wrote = true; return nil }
	repo := &savedPolicies{}
	svc := NewAttendanceService(nil, repo, nil)

	same := &repository.AttendancePolicy{EventID: eventX, RequireQRForEntry: true, AllowManualOverride: true}
	err := access.SavePolicy(context.Background(), svc, security.TrustedCaller{UserID: "mgr"}, acctA, same, same)

	require.NoError(t, err)
	assert.Equal(t, 1, repo.saves, "the save itself still happens")
	assert.False(t, wrote, "an edit that changed no field leaves nothing worth auditing")
}

type savedPolicies struct{ saves int }

func (s *savedPolicies) FindByEventID(context.Context, string) (*repository.AttendancePolicy, error) {
	return nil, repository.ErrNotFound
}

func (s *savedPolicies) Upsert(context.Context, *repository.AttendancePolicy) error {
	s.saves++
	return nil
}
