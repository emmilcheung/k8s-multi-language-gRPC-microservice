package test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/acme/attendance-service/internal/handler"
	"github.com/acme/attendance-service/internal/middleware"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/service"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

type stubScanService struct {
	outcome *service.ScanOutcome
	err     error
}

func (s *stubScanService) Validate(
	_ context.Context,
	_, _, _, _ string,
	_ *string,
) (*service.ScanOutcome, error) {
	if s.outcome != nil {
		return s.outcome, s.err
	}
	return &service.ScanOutcome{Result: service.ScanResultValid}, s.err
}

func (s *stubScanService) CheckIn(
	_ context.Context,
	_, _, _, _ string,
	_ *string,
) (*service.ScanOutcome, error) {
	if s.outcome != nil {
		return s.outcome, s.err
	}
	return &service.ScanOutcome{Result: service.ScanResultValid}, s.err
}

func (s *stubScanService) CheckInByBuyer(
	_ context.Context,
	_, _, _, _ string,
	_ *string,
	_ *repository.AttendancePolicy,
) (*service.ScanOutcome, error) {
	if s.outcome != nil {
		return s.outcome, s.err
	}
	return &service.ScanOutcome{Result: service.ScanResultValid}, s.err
}

// assertErrorEnvelope checks that the response body matches the canonical error shape:
//
//	{"error": {"code": "...", "message": "..."}}
func assertErrorEnvelope(t *testing.T, body []byte, wantCode string) {
	t.Helper()
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(body, &env), "response body must be valid JSON")
	assert.Equal(t, wantCode, env.Error.Code, "error.code mismatch")
	assert.NotEmpty(t, env.Error.Message, "error.message must not be empty")
}

// TestJSONError_Shape_MatchesAPIDesign verifies that handler jsonError returns
// the nested {"error":{"code","message"}} envelope required by docs/03-api-design.md.
func TestJSONError_Shape_MatchesAPIDesign(t *testing.T) {
	e := echo.New()
	svc := service.NewAttendanceService(
		&stubCredentialRepo{err: repository.ErrNotFound},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)
	h := handler.NewAttendanceHandler(svc, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/attendance/tickets/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("ticketId")
	c.SetParamValues("")

	err := h.GetTicket(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "INVALID_PARAM")
}

// TestJSONError_Shape_NotFound verifies NOT_FOUND envelope shape.
func TestJSONError_Shape_NotFound(t *testing.T) {
	e := echo.New()
	svc := service.NewAttendanceService(
		&stubCredentialRepo{err: repository.ErrNotFound},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)
	h := handler.NewAttendanceHandler(svc, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/attendance/tickets/t1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("ticketId")
	c.SetParamValues("t1")
	c.Set(middleware.ContextKeyUserID, "buyer-1")

	err := h.GetTicket(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "NOT_FOUND")
}

func TestGetTicket_NonOwner_ReturnsForbidden(t *testing.T) {
	ownerID := "buyer-owner"
	svc := service.NewAttendanceService(
		&stubCredentialRepo{credential: &repository.AdmissionCredential{
			ID:          "cred-1",
			TicketID:    "t1",
			OrderID:     "o1",
			BuyerUserID: &ownerID,
		}},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)
	h := handler.NewAttendanceHandler(svc, nil)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/attendance/tickets/t1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("ticketId")
	c.SetParamValues("t1")
	c.Set(middleware.ContextKeyUserID, "buyer-other")

	err := h.GetTicket(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "FORBIDDEN")
}

// TestScanHandler_ValidateToken_RequiresScannerIdentity verifies 401 envelope shape.
func TestScanHandler_ValidateToken_RequiresScannerIdentity(t *testing.T) {
	e := echo.New()
	h := handler.NewScanHandler(
		&stubScanService{},
		service.NewAttendanceService(&stubCredentialRepo{}, &stubPolicyRepo{}, &stubScanRepo{}),
		zap.NewNop(),
	)

	req := httptest.NewRequest(http.MethodPost, "/api/attendance/scan/validate",
		strings.NewReader(`{"token":"abc","eventId":"event-1","deviceId":"scanner-1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.ValidateToken(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "MISSING_USER_ID")
}

// TestScanHandler_CheckIn_ReturnsNestedErrorEnvelope verifies INVALID_BODY envelope.
func TestScanHandler_CheckIn_ReturnsNestedErrorEnvelope(t *testing.T) {
	e := echo.New()
	h := handler.NewScanHandler(
		&stubScanService{},
		service.NewAttendanceService(&stubCredentialRepo{}, &stubPolicyRepo{}, &stubScanRepo{}),
		zap.NewNop(),
	)

	req := httptest.NewRequest(http.MethodPost, "/api/attendance/scan/check-in", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.CheckIn(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "INVALID_BODY")
}

// TestKongAuth_Unauthorized_MatchesAPIDesign verifies that the auth middleware
// returns the canonical error envelope when X-User-Id is absent.
func TestKongAuth_Unauthorized_MatchesAPIDesign(t *testing.T) {
	e := echo.New()
	called := false
	handler := middleware.KongAuth(true)(func(c echo.Context) error {
		called = true
		return nil
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := handler(c)
	require.NoError(t, err)
	assert.False(t, called, "next handler must not be called when auth fails")
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "MISSING_USER_ID")
}

// TestPatchEventSettings_FirstCreate_SetsOrganizerID verifies that when no
// policy exists yet, PatchEventSettings creates one with the caller's user ID
// as the organizer_id, not an empty string.
func TestPatchEventSettings_FirstCreate_SetsOrganizerID(t *testing.T) {
	const userID = "organizer-uuid-123"

	captured := &capturePolicyRepo{}
	// Provide a stub lookup that confirms this organizer owns the event; without it
	// EnsureOrganizerOwnsEvent now fails closed (ErrForbidden) per the R4 fix.
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		captured,
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: userID},
	)
	h := handler.NewAttendanceHandler(svc, nil)

	e := echo.New()
	req := httptest.NewRequest(http.MethodPatch, "/api/attendance/events/event-1/settings",
		strings.NewReader(`{"requireQrForEntry":false}`))
	req.Header.Set(echo.MIMEApplicationJSON, "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-User-Id", userID)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	// Simulate KongAuth middleware having run.
	c.Set(middleware.ContextKeyUserID, userID)

	err := h.PatchEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)

	require.NotNil(t, captured.upserted, "policy must have been upserted")
	assert.Equal(t, userID, captured.upserted.OrganizerID,
		"organizer_id must be the authenticated user, not an empty string")
	assert.Equal(t, "event-1", captured.upserted.EventID)
}

// TestPatchEventSettings_FirstCreate_Requires_UserID verifies that when no
// policy exists and no user identity is present, the handler returns 401.
func TestPatchEventSettings_FirstCreate_Requires_UserID(t *testing.T) {
	svc := service.NewAttendanceService(
		&stubCredentialRepo{},
		&stubPolicyRepo{err: repository.ErrNotFound},
		&stubScanRepo{},
	)
	h := handler.NewAttendanceHandler(svc, nil)

	e := echo.New()
	req := httptest.NewRequest(http.MethodPatch, "/api/attendance/events/event-1/settings",
		strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	// No X-User-Id header and no context key set — anonymous caller.
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")

	err := h.PatchEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "MISSING_USER_ID")
}

// capturePolicyRepo is a test double that records the policy passed to Upsert.
type capturePolicyRepo struct {
	upserted *repository.AttendancePolicy
}

func (c *capturePolicyRepo) FindByEventID(_ context.Context, _ string) (*repository.AttendancePolicy, error) {
	// Return ErrNotFound to trigger the first-create code path.
	return nil, repository.ErrNotFound
}

func (c *capturePolicyRepo) Upsert(_ context.Context, policy *repository.AttendancePolicy) error {
	c.upserted = policy
	return nil
}

func TestGetEventSettings_NonOwner_ReturnsForbidden(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "owner-uuid-1"},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/attendance/events/event-1/settings", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	c.Set(middleware.ContextKeyUserID, "other-user")

	err := h.GetEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "FORBIDDEN")
}

func TestPatchEventSettings_UnknownEvent_ReturnsNotFound(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{err: repository.ErrNotFound},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodPatch, "/api/attendance/events/event-404/settings",
		strings.NewReader(`{"requireQrForEntry":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-404")
	c.Set(middleware.ContextKeyUserID, "organizer-uuid")

	err := h.PatchEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "NOT_FOUND")
}

func TestPatchEventSettings_MalformedPayload_ReturnsBadRequest(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "organizer-uuid"},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodPatch, "/api/attendance/events/event-1/settings", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	c.Set(middleware.ContextKeyUserID, "organizer-uuid")

	err := h.PatchEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "INVALID_BODY")
}

func TestPatchEventSettings_OwnerCanUpdatePolicy(t *testing.T) {
	captured := &capturePolicyRepo{}
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		captured,
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "organizer-uuid"},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodPatch, "/api/attendance/events/event-1/settings",
		strings.NewReader(`{"requireQrForEntry":false,"allowManualOverride":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	c.Set(middleware.ContextKeyUserID, "organizer-uuid")

	err := h.PatchEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)
	require.NotNil(t, captured.upserted)
	assert.Equal(t, "organizer-uuid", captured.upserted.OrganizerID)
	assert.False(t, captured.upserted.RequireQRForEntry)
	assert.True(t, captured.upserted.AllowManualOverride)
}

func TestGetEventSettings_UnknownEvent_ReturnsNotFound(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{err: repository.ErrNotFound},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/attendance/events/event-missing/settings", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-missing")
	c.Set(middleware.ContextKeyUserID, "organizer-uuid")

	err := h.GetEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusNotFound, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "NOT_FOUND")
}

func TestGetEventSettings_OwnerWithNoPolicy_ReturnsDefaults(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{err: repository.ErrNotFound},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "organizer-uuid"},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/attendance/events/event-1/settings", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	c.Set(middleware.ContextKeyUserID, "organizer-uuid")

	err := h.GetEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, true, body["requireQrForEntry"])
	assert.Equal(t, false, body["allowManualOverride"])
}

func TestPatchEventSettings_OwnershipLookupFailure_ReturnsInternalError(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{err: errors.New("ticket-service unavailable")},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodPatch, "/api/attendance/events/event-1/settings",
		strings.NewReader(`{"requireQrForEntry":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	c.Set(middleware.ContextKeyUserID, "organizer-uuid")

	err := h.PatchEventSettings(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "INTERNAL_ERROR")
}

func TestGetEventSummary_ForbiddenWhenNotOwner(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "organizer-A"},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/attendance/events/event-1/summary", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	c.Set(middleware.ContextKeyUserID, "other-user-B") // not the owner

	err := h.GetEventSummary(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "FORBIDDEN")
}

func TestGetEventSummary_OkWhenOwner(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "organizer-A"},
	)
	h := handler.NewAttendanceHandler(svc, zap.NewNop())

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/attendance/events/event-1/summary", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("eventId")
	c.SetParamValues("event-1")
	c.Set(middleware.ContextKeyUserID, "organizer-A")

	err := h.GetEventSummary(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)
}
