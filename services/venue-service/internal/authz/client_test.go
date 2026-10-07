package authz

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	accountsv1 "github.com/org/ticketing/libs/grpc-stubs/go/accounts/v1"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/acme/venue-service/internal/security"
)

// fakeAccounts answers CheckPermission from a mutable verdict and counts calls.
type fakeAccounts struct {
	accountsv1.AccountsServiceClient
	mu       sync.Mutex
	calls    int
	last     *accountsv1.CheckPermissionRequest
	response *accountsv1.CheckPermissionResponse
	err      error
}

func (f *fakeAccounts) CheckPermission(_ context.Context, in *accountsv1.CheckPermissionRequest, _ ...grpc.CallOption) (*accountsv1.CheckPermissionResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.last = in
	return f.response, f.err
}

func (f *fakeAccounts) set(r *accountsv1.CheckPermissionResponse, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.response, f.err = r, err
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

var (
	alice = security.TrustedCaller{UserID: "user-alice"}
	scope = Scope{AccountID: "acct-1", EventID: "evt-1"}
)

func allow() *accountsv1.CheckPermissionResponse {
	return &accountsv1.CheckPermissionResponse{Allowed: true}
}

func deny(r accountsv1.ReasonCode) *accountsv1.CheckPermissionResponse {
	return &accountsv1.CheckPermissionResponse{Allowed: false, ReasonCode: r}
}

func newTestClient(mode Mode, rpc accountsv1.AccountsServiceClient) (*Client, *fakeClock, *observer.ObservedLogs) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	core, logs := observer.New(zap.WarnLevel)
	c := New(mode, rpc, zap.New(core), WithClock(clock.now))
	return c, clock, logs
}

func TestAllowAndDenyAreCachedForTheTTL(t *testing.T) {
	rpc := &fakeAccounts{}
	c, clock, _ := newTestClient(ModeOn, rpc)

	rpc.set(allow(), nil)
	for i := 0; i < 3; i++ {
		d, err := c.Check(context.Background(), alice, "event.edit", scope)
		if err != nil || !d.Allowed {
			t.Fatalf("want allowed, got %+v err=%v", d, err)
		}
	}
	other := Scope{AccountID: "acct-2"}
	rpc.set(deny(accountsv1.ReasonCode_REASON_CODE_NOT_MEMBER), nil)
	for i := 0; i < 3; i++ {
		d, err := c.Check(context.Background(), alice, "event.edit", other)
		if err != nil || d.Allowed || d.Reason != ReasonNotMember {
			t.Fatalf("want not-member denial, got %+v err=%v", d, err)
		}
	}
	if rpc.calls != 2 {
		t.Errorf("one call per distinct request inside the TTL, got %d calls", rpc.calls)
	}

	clock.advance(DefaultCacheTTL - time.Second)
	_, _ = c.Check(context.Background(), alice, "event.edit", scope)
	if rpc.calls != 2 {
		t.Errorf("just inside the TTL must still be a cache hit, got %d calls", rpc.calls)
	}
}

func TestARemovedMemberIsDeniedAfterTheTTL(t *testing.T) {
	rpc := &fakeAccounts{}
	c, clock, _ := newTestClient(ModeOn, rpc)

	rpc.set(allow(), nil)
	if d, _ := c.Check(context.Background(), alice, "event.edit", scope); !d.Allowed {
		t.Fatal("member must be allowed before removal")
	}

	rpc.set(deny(accountsv1.ReasonCode_REASON_CODE_NOT_MEMBER), nil)
	if d, _ := c.Check(context.Background(), alice, "event.edit", scope); !d.Allowed {
		t.Fatal("inside the TTL the cached allow still applies")
	}

	clock.advance(DefaultCacheTTL + time.Second)
	d, err := c.Check(context.Background(), alice, "event.edit", scope)
	if err != nil || d.Allowed {
		t.Fatalf("after the TTL the removed member must be denied, got %+v err=%v", d, err)
	}
	if d.Reason != ReasonNotMember {
		t.Errorf("reason = %q, want %q", d.Reason, ReasonNotMember)
	}
}

func TestEveryPartOfTheRequestSeparatesCacheEntries(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, _ := newTestClient(ModeOn, rpc)
	rpc.set(allow(), nil)

	admin := security.TrustedCaller{UserID: alice.UserID, PlatformRoles: []string{"platform_admin"}}
	variants := []struct {
		caller security.TrustedCaller
		perm   string
		scope  Scope
	}{
		{alice, "event.edit", scope},
		{security.TrustedCaller{UserID: "user-bob"}, "event.edit", scope},
		{admin, "event.edit", scope},
		{alice, "event.publish", scope},
		{alice, "event.edit", Scope{AccountID: "acct-9", EventID: "evt-1"}},
		{alice, "event.edit", Scope{AccountID: "acct-1", VenueID: "ven-1", EventID: "evt-1"}},
		{alice, "event.edit", Scope{AccountID: "acct-1", EventID: "evt-2"}},
	}
	for _, v := range variants {
		if _, err := c.Check(context.Background(), v.caller, v.perm, v.scope); err != nil {
			t.Fatal(err)
		}
	}
	if rpc.calls != len(variants) {
		t.Errorf("a cached answer for one caller or scope must never answer another: %d calls for %d requests", rpc.calls, len(variants))
	}
}

func TestPlatformRolesAndScopeAreForwardedAndNotInterpretedInGo(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, _ := newTestClient(ModeOn, rpc)
	rpc.set(deny(accountsv1.ReasonCode_REASON_CODE_NOT_MEMBER), nil)

	admin := security.TrustedCaller{UserID: "user-root", PlatformRoles: []string{"platform_admin"}}
	d, err := c.Check(context.Background(), admin, "venue.edit_profile", Scope{AccountID: "a", VenueID: "v", EventID: "e"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Allowed {
		t.Error("user-service decides: a platform admin the server denied must stay denied")
	}
	got := rpc.last
	if got.UserId != "user-root" || got.Permission != "venue.edit_profile" ||
		got.AccountId != "a" || got.VenueId != "v" || got.EventId != "e" ||
		len(got.PlatformRoles) != 1 || got.PlatformRoles[0] != "platform_admin" {
		t.Errorf("request not forwarded verbatim: %+v", got)
	}
}

func TestUserServiceUnreachableFailsClosedWhenEnforcing(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, _ := newTestClient(ModeOn, rpc)
	rpc.set(nil, status.Error(codes.Unavailable, "connection refused"))

	d, err := c.Check(context.Background(), alice, "event.edit", scope)
	if !errors.Is(err, ErrAuthzUnavailable) {
		t.Fatalf("want ErrAuthzUnavailable so callers answer 503, got %v", err)
	}
	if d.Allowed {
		t.Error("an unreachable user-service must never allow")
	}
}

func TestAnUnavailableAnswerIsNotCachedSoRecoveryIsImmediate(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, _ := newTestClient(ModeOn, rpc)

	rpc.set(nil, status.Error(codes.DeadlineExceeded, "slow"))
	if _, err := c.Check(context.Background(), alice, "event.edit", scope); !errors.Is(err, ErrAuthzUnavailable) {
		t.Fatalf("want unavailable, got %v", err)
	}
	rpc.set(allow(), nil)
	d, err := c.Check(context.Background(), alice, "event.edit", scope)
	if err != nil || !d.Allowed {
		t.Fatalf("the outage must not linger in the cache, got %+v err=%v", d, err)
	}
}

func TestAMalformedRequestRejectionIsNotReportedAsAnOutage(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, _ := newTestClient(ModeOn, rpc)
	rpc.set(nil, status.Error(codes.InvalidArgument, "unknown permission"))

	d, err := c.Check(context.Background(), alice, "nope", scope)
	if err == nil || errors.Is(err, ErrAuthzUnavailable) {
		t.Fatalf("a bad request is a bug in this service, not a 503, got %v", err)
	}
	if d.Allowed {
		t.Error("must not allow")
	}
}

func TestCallsCarryA300MillisecondDeadline(t *testing.T) {
	var deadline time.Time
	var ok bool
	rpc := &deadlineProbe{onCall: func(ctx context.Context) { deadline, ok = ctx.Deadline() }}
	c, _, _ := newTestClient(ModeOn, rpc)

	start := time.Now()
	if _, err := c.Check(context.Background(), alice, "event.edit", scope); err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("the call must have a deadline so a slow user-service cannot hang organizer writes")
	}
	if d := deadline.Sub(start); d > 350*time.Millisecond || d < 250*time.Millisecond {
		t.Errorf("deadline %v away, want about 300ms", d)
	}
}

type deadlineProbe struct {
	accountsv1.AccountsServiceClient
	onCall func(context.Context)
}

func (p *deadlineProbe) CheckPermission(ctx context.Context, _ *accountsv1.CheckPermissionRequest, _ ...grpc.CallOption) (*accountsv1.CheckPermissionResponse, error) {
	p.onCall(ctx)
	return allow(), nil
}

func TestLogModeNeverBlocksAndRecordsWouldDeny(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, logs := newTestClient(ModeLog, rpc)
	rpc.set(deny(accountsv1.ReasonCode_REASON_CODE_ROLE_LACKS_PERMISSION), nil)

	before := testutil.ToFloat64(decisions.WithLabelValues("log", "deny", ReasonRoleLacksPermission))
	d, err := c.Check(context.Background(), alice, "event.publish", scope)
	if err != nil || !d.Allowed {
		t.Fatalf("log mode must let the old check decide, got %+v err=%v", d, err)
	}
	if logs.FilterMessage("authz would deny").Len() != 1 {
		t.Errorf("want one would-deny log line, got %v", logs.All())
	}
	after := testutil.ToFloat64(decisions.WithLabelValues("log", "deny", ReasonRoleLacksPermission))
	if after-before != 1 {
		t.Errorf("the would-deny must be counted by reason, delta %v", after-before)
	}
}

func TestLogModeSurvivesAnOutageWithoutBlocking(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, logs := newTestClient(ModeLog, rpc)
	rpc.set(nil, status.Error(codes.Unavailable, "down"))

	d, err := c.Check(context.Background(), alice, "event.edit", scope)
	if err != nil || !d.Allowed {
		t.Fatalf("log mode must never block, got %+v err=%v", d, err)
	}
	if logs.FilterMessage("authz would-check unavailable").Len() != 1 {
		t.Errorf("want a would-check-unavailable line, got %v", logs.All())
	}
}

func TestLogModeWithoutAnAddressLogsAndNeverBlocks(t *testing.T) {
	c, _, logs := newTestClient(ModeLog, nil)

	d, err := c.Check(context.Background(), alice, "event.edit", scope)
	if err != nil || !d.Allowed {
		t.Fatalf("got %+v err=%v", d, err)
	}
	if logs.FilterMessage("authz would-check unavailable").Len() != 1 {
		t.Errorf("want a would-check-unavailable line, got %v", logs.All())
	}
}

func TestLogModeDoesNotLogWouldDenyForAllowedRequests(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, logs := newTestClient(ModeLog, rpc)
	rpc.set(allow(), nil)

	if _, err := c.Check(context.Background(), alice, "event.edit", scope); err != nil {
		t.Fatal(err)
	}
	if logs.Len() != 0 {
		t.Errorf("an allowed request is silent, got %v", logs.All())
	}
}

func TestOffModeNeverCallsUserService(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, _ := newTestClient(ModeOff, rpc)

	d, err := c.Check(context.Background(), alice, "event.edit", scope)
	if err != nil || !d.Allowed {
		t.Fatalf("got %+v err=%v", d, err)
	}
	if rpc.calls != 0 {
		t.Errorf("off mode must not dial, got %d calls", rpc.calls)
	}
}

func TestEnforcingWithoutAClientFailsClosed(t *testing.T) {
	c, _, _ := newTestClient(ModeOn, nil)

	d, err := c.Check(context.Background(), alice, "event.edit", scope)
	if !errors.Is(err, ErrAuthzUnavailable) || d.Allowed {
		t.Fatalf("got %+v err=%v", d, err)
	}
}

func TestEachDecisionIsCountedByModeAndReason(t *testing.T) {
	rpc := &fakeAccounts{}
	c, _, _ := newTestClient(ModeOn, rpc)

	cases := []struct {
		code   accountsv1.ReasonCode
		reason string
	}{
		{accountsv1.ReasonCode_REASON_CODE_NOT_MEMBER, ReasonNotMember},
		{accountsv1.ReasonCode_REASON_CODE_ROLE_LACKS_PERMISSION, ReasonRoleLacksPermission},
		{accountsv1.ReasonCode_REASON_CODE_ACCOUNT_SUSPENDED, ReasonAccountSuspended},
		{accountsv1.ReasonCode_REASON_CODE_OUT_OF_SCOPE, ReasonOutOfScope},
	}
	for i, tc := range cases {
		before := testutil.ToFloat64(decisions.WithLabelValues("on", "deny", tc.reason))
		rpc.set(deny(tc.code), nil)
		d, _ := c.Check(context.Background(), alice, "event.edit", Scope{AccountID: string(rune('a' + i))})
		if d.Reason != tc.reason {
			t.Errorf("reason = %q, want %q", d.Reason, tc.reason)
		}
		if got := testutil.ToFloat64(decisions.WithLabelValues("on", "deny", tc.reason)) - before; got != 1 {
			t.Errorf("%s not counted, delta %v", tc.reason, got)
		}
	}
}

func TestParseModeRejectsUnknownValues(t *testing.T) {
	for _, ok := range []string{"off", "log", "on"} {
		if _, err := ParseMode(ok); err != nil {
			t.Errorf("%q should parse: %v", ok, err)
		}
	}
	if _, err := ParseMode("enforce"); err == nil {
		t.Error("a typo must fail startup instead of silently disabling enforcement")
	}
}
