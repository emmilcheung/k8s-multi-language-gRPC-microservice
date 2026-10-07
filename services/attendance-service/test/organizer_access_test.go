package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/acme/attendance-service/internal/authz"
	gqlgraph "github.com/acme/attendance-service/internal/graphql"
	"github.com/acme/attendance-service/internal/handler"
	"github.com/acme/attendance-service/internal/middleware"
	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/security"
	"github.com/acme/attendance-service/internal/service"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

const (
	orgAccount = "11111111-1111-1111-1111-111111111111"
	eventOne   = "ticket-1"
	eventTwo   = "ticket-2"
)

// doorStaffAuthz allows attendance.scan only for the listed users on the
// listed events, event.edit for managers only, and nothing for anyone else.
type doorStaffAuthz struct {
	managers   map[string]bool
	doorEvents map[string][]string
	err        error
}

func (d doorStaffAuthz) Check(_ context.Context, c security.TrustedCaller, perm string, s authz.Scope) (authz.Decision, error) {
	if d.err != nil {
		return authz.Decision{}, d.err
	}
	if d.managers[c.UserID] {
		return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
	}
	if events, ok := d.doorEvents[c.UserID]; ok && perm == service.PermAttendanceScan {
		for _, e := range events {
			if e == s.EventID {
				return authz.Decision{Allowed: true, Reason: authz.ReasonAllowed}, nil
			}
		}
		return authz.Decision{Reason: authz.ReasonOutOfScope}, nil
	}
	return authz.Decision{Reason: authz.ReasonRoleLacksPermission}, nil
}

type accountTickets struct{}

func (accountTickets) LookupTicketOwnership(_ context.Context, id string) (service.TicketOwner, error) {
	if id == eventOne || id == eventTwo {
		return service.TicketOwner{UserID: "creator", AccountID: orgAccount}, nil
	}
	return service.TicketOwner{}, repository.ErrNotFound
}

type tokenEvents map[string]string

func (t tokenEvents) Verify(token string) (*qr.Claims, error) {
	if e, ok := t[token]; ok {
		return &qr.Claims{EventID: e}, nil
	}
	return nil, qr.ErrTokenInvalid
}

type countingScanSvc struct {
	stubScanService
	validated int
}

func (c *countingScanSvc) Validate(ctx context.Context, token, eventID, scanner, device string, gate *string) (*service.ScanOutcome, error) {
	c.validated++
	return c.stubScanService.Validate(ctx, token, eventID, scanner, device, gate)
}

func enforcingAccess(a service.Authorizer) *service.OrganizerAccess {
	return service.NewOrganizerAccess(a, authz.ModeOn, accountTickets{},
		tokenEvents{"token-one": eventOne, "token-two": eventTwo}, nil, nil, zap.NewNop())
}

func graphqlCtx(user string) context.Context {
	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	req.Header.Set("X-User-Id", user)
	req.Header.Set("X-Organizer-Account", orgAccount)
	return gqlgraph.WithHTTPRequest(context.Background(), req)
}

func TestGraphQL_ValidateScan_IsRefusedForANonMemberAndNeverReachesTheScanner(t *testing.T) {
	scan := &countingScanSvc{}
	r := &gqlgraph.Resolver{
		Svc:     service.NewAttendanceService(nil, nil, nil),
		ScanSvc: scan,
		Access:  enforcingAccess(doorStaffAuthz{doorEvents: map[string][]string{"door": {eventOne}}}),
	}

	_, err := r.Mutation().ValidateScan(graphqlCtx("stranger"), "token-one")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")
	assert.Zero(t, scan.validated, "a refused caller must not cause a scan record")

	_, err = r.Mutation().ValidateScan(graphqlCtx("door"), "token-one")
	require.NoError(t, err)
	_, err = r.Mutation().ValidateScan(graphqlCtx("door"), "token-two")
	require.Error(t, err, "door staff limited to the first event cannot validate the second")
	assert.Equal(t, 1, scan.validated)
}

func TestGraphQL_PermissionServiceFaultsAreHiddenFromTheClient(t *testing.T) {
	r := &gqlgraph.Resolver{
		Svc:     service.NewAttendanceService(nil, nil, nil),
		ScanSvc: &stubScanService{},
		Access:  enforcingAccess(doorStaffAuthz{err: authz.ErrAuthzUnavailable}),
	}
	_, err := r.Mutation().ValidateScan(graphqlCtx("door"), "token-one")
	require.Error(t, err)
	assert.Equal(t, "unavailable: permission check unavailable, try again", err.Error())

	r.Access = enforcingAccess(doorStaffAuthz{err: errTest("user-service said: secret detail")})
	_, err = r.Mutation().ValidateScan(graphqlCtx("door"), "token-one")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret detail")
}

type errTest string

func (e errTest) Error() string { return string(e) }

func TestGraphQL_PolicyEdit_NeedsEventEditAndDoorStaffCannot(t *testing.T) {
	policies := &stubPolicyRepoWithUpsert{}
	svc := service.NewAttendanceService(nil, policies, nil)
	r := &gqlgraph.Resolver{
		Svc: svc, ScanSvc: &stubScanService{},
		Access: enforcingAccess(doorStaffAuthz{
			managers:   map[string]bool{"manager": true},
			doorEvents: map[string][]string{"door": {eventOne}},
		}),
	}
	on := true

	_, err := r.Mutation().UpdateAttendancePolicy(graphqlCtx("door"), eventOne, gqlgraph.UpdateAttendancePolicyInput{AllowManualOverride: &on})
	require.Error(t, err)
	assert.Nil(t, policies.upserted)

	got, err := r.Mutation().UpdateAttendancePolicy(graphqlCtx("manager"), eventOne, gqlgraph.UpdateAttendancePolicyInput{AllowManualOverride: &on})
	require.NoError(t, err)
	assert.True(t, got.AllowManualOverride)
	assert.NotNil(t, policies.upserted)
}

func scanRequest(access *service.OrganizerAccess, user, path, body string) *httptest.ResponseRecorder {
	e := echo.New()
	h := handler.NewScanHandler(&stubScanService{}, service.NewAttendanceService(nil, &stubPolicyRepo{
		policy: &repository.AttendancePolicy{RequireQRForEntry: true},
	}, nil), zap.NewNop()).WithAccess(access)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Organizer-Account", orgAccount)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set(middleware.ContextKeyUserID, user)
	_ = h.CheckIn(c)
	return rec
}

func TestREST_CheckIn_DoorStaffScopedToOneEventCanScanItAndNotTheOther(t *testing.T) {
	access := enforcingAccess(doorStaffAuthz{doorEvents: map[string][]string{"door": {eventOne}}})

	ok := scanRequest(access, "door", "/api/attendance/scan/check-in", `{"token":"t","eventId":"`+eventOne+`","deviceId":"d"}`)
	assert.Equal(t, http.StatusOK, ok.Code, ok.Body.String())

	denied := scanRequest(access, "door", "/api/attendance/scan/check-in", `{"token":"t","eventId":"`+eventTwo+`","deviceId":"d"}`)
	assert.Equal(t, http.StatusForbidden, denied.Code)
}

func TestREST_CheckIn_FailsClosedWith503WhenThePermissionServiceIsDown(t *testing.T) {
	access := enforcingAccess(doorStaffAuthz{err: authz.ErrAuthzUnavailable})
	rec := scanRequest(access, "door", "/api/attendance/scan/check-in", `{"token":"t","eventId":"`+eventOne+`","deviceId":"d"}`)
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestREST_PatchSettings_RefusesDoorStaffAndLetsAManagerThrough(t *testing.T) {
	access := enforcingAccess(doorStaffAuthz{
		managers:   map[string]bool{"manager": true},
		doorEvents: map[string][]string{"door": {eventOne}},
	})
	patch := func(user string) int {
		e := echo.New()
		policies := &stubPolicyRepoWithUpsert{}
		h := handler.NewAttendanceHandler(service.NewAttendanceService(nil, policies, nil), zap.NewNop()).WithAccess(access)
		req := httptest.NewRequest(http.MethodPatch, "/api/attendance/events/"+eventOne+"/settings",
			strings.NewReader(`{"allowManualOverride":true}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Organizer-Account", orgAccount)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("eventId")
		c.SetParamValues(eventOne)
		c.Set(middleware.ContextKeyUserID, user)
		require.NoError(t, h.PatchEventSettings(c))
		return rec.Code
	}
	assert.Equal(t, http.StatusForbidden, patch("door"))
	assert.Equal(t, http.StatusOK, patch("manager"))
}
