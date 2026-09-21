package test

import (
	"context"
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

// setupScanHandlerWithPolicy constructs a ScanHandler wired with a real
// AttendanceService backed by the provided stubs. The ticket owner is always
// "scanner-user" so EnsureOrganizerOwnsEvent passes.
func setupScanHandlerWithPolicy(
	policyRepo repository.PolicyRepository,
	scanSvc service.ScanService,
) (*handler.ScanHandler, *echo.Echo) {
	auth := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		policyRepo,
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "scanner-user"},
	)
	h := handler.NewScanHandler(scanSvc, auth, zap.NewNop())
	e := echo.New()
	return h, e
}

// makeCheckInByBuyerCtx builds an echo.Context for a POST check-in-user request.
func makeCheckInByBuyerCtx(e *echo.Echo, rec *httptest.ResponseRecorder) echo.Context {
	body := `{"eventId":"event-1","buyerUserId":"buyer-1","deviceId":"scanner-device-1"}`
	req := httptest.NewRequest(http.MethodPost, "/api/attendance/scan/check-in-user",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	c := e.NewContext(req, rec)
	c.Set(middleware.ContextKeyUserID, "scanner-user")
	return c
}

// TestPolicyEnforcement_ManualOverrideDisabled_ReturnsPolicyBlock verifies that
// CheckInByBuyer returns 403 POLICY_BLOCK when the event policy has
// allow_manual_override = false.
func TestPolicyEnforcement_ManualOverrideDisabled_ReturnsPolicyBlock(t *testing.T) {
	policy := &repository.AttendancePolicy{
		EventID:             "event-1",
		RequireQRForEntry:   true,
		AllowManualOverride: false,
	}
	policyRepo := &stubPolicyRepo{policy: policy}
	scanSvc := &fixedPolicyBlockScanSvc{}
	h, e := setupScanHandlerWithPolicy(policyRepo, scanSvc)

	rec := httptest.NewRecorder()
	c := makeCheckInByBuyerCtx(e, rec)

	err := h.CheckInByBuyer(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "POLICY_BLOCK")
}

// TestPolicyEnforcement_NoPolicyRow_ReturnsPolicyBlock verifies that when no
// policy row exists for the event, CheckInByBuyer defaults to blocked
// (allow_manual_override defaults to false when no row exists).
func TestPolicyEnforcement_NoPolicyRow_ReturnsPolicyBlock(t *testing.T) {
	policyRepo := &stubPolicyRepo{err: repository.ErrNotFound}
	scanSvc := &fixedPolicyBlockScanSvc{}
	h, e := setupScanHandlerWithPolicy(policyRepo, scanSvc)

	rec := httptest.NewRecorder()
	c := makeCheckInByBuyerCtx(e, rec)

	err := h.CheckInByBuyer(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assertErrorEnvelope(t, rec.Body.Bytes(), "POLICY_BLOCK")
}

// TestPolicyEnforcement_ManualOverrideEnabled_Succeeds verifies that CheckInByBuyer
// proceeds (2xx) when allow_manual_override = true.
func TestPolicyEnforcement_ManualOverrideEnabled_Succeeds(t *testing.T) {
	policy := &repository.AttendancePolicy{
		EventID:             "event-1",
		RequireQRForEntry:   true,
		AllowManualOverride: true,
	}
	policyRepo := &stubPolicyRepo{policy: policy}
	// Stub scan service returns a valid outcome when policy allows it.
	scanSvc := &stubScanService{outcome: &service.ScanOutcome{Result: service.ScanResultValid}}
	h, e := setupScanHandlerWithPolicy(policyRepo, scanSvc)

	rec := httptest.NewRecorder()
	c := makeCheckInByBuyerCtx(e, rec)

	err := h.CheckInByBuyer(c)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, rec.Code)
}

// fixedPolicyBlockScanSvc is a ScanService stub whose CheckInByBuyer always
// returns ErrPolicyBlock, simulating policy enforcement at the service layer.
type fixedPolicyBlockScanSvc struct{}

func (s *fixedPolicyBlockScanSvc) Validate(
	_ context.Context,
	_, _, _, _ string,
	_ *string,
) (*service.ScanOutcome, error) {
	panic("not called in policy enforcement tests")
}

func (s *fixedPolicyBlockScanSvc) CheckIn(
	_ context.Context,
	_, _, _, _ string,
	_ *string,
) (*service.ScanOutcome, error) {
	panic("not called in policy enforcement tests")
}

func (s *fixedPolicyBlockScanSvc) CheckInByBuyer(
	_ context.Context,
	_, _, _, _ string,
	_ *string,
	_ *repository.AttendancePolicy,
) (*service.ScanOutcome, error) {
	return &service.ScanOutcome{Result: service.ScanResultRevoked}, service.ErrPolicyBlock
}
