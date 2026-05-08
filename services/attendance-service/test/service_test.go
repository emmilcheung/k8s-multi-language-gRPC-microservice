package test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubCredentialRepo is a test double for CredentialRepository.
type stubCredentialRepo struct {
	credential *repository.AdmissionCredential
	checkedIn  []*repository.AdmissionCredential
	err        error
}

func (s *stubCredentialRepo) FindByID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return s.credential, s.err
}

func (s *stubCredentialRepo) FindByTicketID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return s.credential, s.err
}

func (s *stubCredentialRepo) FindByTicketAndBuyer(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	return s.credential, s.err
}

func (s *stubCredentialRepo) FindByTicketAndOrder(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	return s.credential, s.err
}

func (s *stubCredentialRepo) FindByIssuanceKey(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return s.credential, s.err
}

func (s *stubCredentialRepo) CreateWithOutbox(_ context.Context, _ *repository.AdmissionCredential, _ *repository.OutboxRow) error {
	return s.err
}

func (s *stubCredentialRepo) Create(_ context.Context, _ *repository.AdmissionCredential) error {
	return s.err
}

func (s *stubCredentialRepo) ConsumeIssued(
	_ context.Context,
	_ string,
	_ time.Time,
	_, _ string,
) (*repository.AdmissionCredential, bool, error) {
	return s.credential, false, s.err
}

func (s *stubCredentialRepo) UpdateStatus(_ context.Context, _ string, _ repository.CredentialStatus) error {
	return s.err
}

func (s *stubCredentialRepo) MarkEventPublished(_ context.Context, _ string, _ time.Time) error {
	return s.err
}

func (s *stubCredentialRepo) ListCheckedInByEventID(_ context.Context, _ string, _ int) ([]*repository.AdmissionCredential, error) {
	if s.checkedIn != nil {
		return s.checkedIn, s.err
	}
	return []*repository.AdmissionCredential{}, s.err
}

// stubPolicyRepo is a test double for PolicyRepository.
type stubPolicyRepo struct {
	policy *repository.AttendancePolicy
	err    error
}

func (s *stubPolicyRepo) FindByEventID(_ context.Context, _ string) (*repository.AttendancePolicy, error) {
	return s.policy, s.err
}

func (s *stubPolicyRepo) Upsert(_ context.Context, _ *repository.AttendancePolicy) error {
	return s.err
}

// stubScanRepo is a test double for ScanEventRepository.
type stubScanRepo struct {
	summary *repository.AttendanceSummary
	err     error
}

type stubTicketOwnerLookupSvc struct {
	ownerID string
	err     error
}

func (s *stubTicketOwnerLookupSvc) LookupTicketOwner(_ context.Context, _ string) (string, error) {
	if s.err != nil {
		return "", s.err
	}
	return s.ownerID, nil
}

func (s *stubScanRepo) Create(_ context.Context, _ *repository.ScanEvent) error {
	return s.err
}

func (s *stubScanRepo) SummarizeByEventID(_ context.Context, eventID string) (*repository.AttendanceSummary, error) {
	if s.summary != nil {
		return s.summary, s.err
	}
	return &repository.AttendanceSummary{EventID: eventID}, s.err
}

// TestGetAdmissionPass_ReturnsCredential_WhenFound verifies that the service
// delegates to the repository and maps the result correctly.
func TestGetAdmissionPass_ReturnsCredential_WhenFound(t *testing.T) {
	now := time.Now()
	cred := &repository.AdmissionCredential{
		ID:       "cred-1",
		TicketID: "ticket-1",
		OrderID:  "order-1",
		EventID:  "event-1",
		Status:   repository.CredentialStatusIssued,
		IssuedAt: now,
	}

	svc := service.NewAttendanceService(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)

	got, err := svc.GetAdmissionPass(context.Background(), "ticket-1", nil)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "cred-1", got.ID)
	assert.Equal(t, repository.CredentialStatusIssued, got.Status)
}

// TestGetAdmissionPass_ReturnsNotFound_WhenMissing checks ErrNotFound propagation.
func TestGetAdmissionPass_ReturnsNotFound_WhenMissing(t *testing.T) {
	svc := service.NewAttendanceService(
		&stubCredentialRepo{err: repository.ErrNotFound},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)

	_, err := svc.GetAdmissionPass(context.Background(), "ticket-x", nil)
	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrNotFound))
}

func TestGetAdmissionPassForBuyer_ReturnsCredential_WhenOwnedByCaller(t *testing.T) {
	buyerID := "buyer-1"
	cred := &repository.AdmissionCredential{
		ID:          "cred-1",
		TicketID:    "ticket-1",
		OrderID:     "order-1",
		BuyerUserID: &buyerID,
		Status:      repository.CredentialStatusIssued,
	}
	svc := service.NewAttendanceService(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)
	got, err := svc.GetAdmissionPassForBuyer(context.Background(), "ticket-1", nil, buyerID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "cred-1", got.ID)
}

func TestGetAdmissionPassForBuyer_ReturnsForbidden_WhenCredentialBelongsToDifferentBuyer(t *testing.T) {
	ownerID := "buyer-1"
	cred := &repository.AdmissionCredential{
		ID:          "cred-1",
		TicketID:    "ticket-1",
		OrderID:     "order-1",
		BuyerUserID: &ownerID,
		Status:      repository.CredentialStatusIssued,
	}
	svc := service.NewAttendanceService(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)
	_, err := svc.GetAdmissionPassForBuyer(context.Background(), "ticket-1", nil, "other-buyer")
	require.Error(t, err)
	assert.True(t, errors.Is(err, service.ErrForbidden))
}

// TestGetAttendancePolicy_ReturnsPolicy_WhenFound tests policy retrieval.
func TestGetAttendancePolicy_ReturnsPolicy_WhenFound(t *testing.T) {
	policy := &repository.AttendancePolicy{
		EventID:             "event-1",
		RequireQRForEntry:   true,
		AllowManualOverride: false,
	}

	svc := service.NewAttendanceService(
		&stubCredentialRepo{},
		&stubPolicyRepo{policy: policy},
		&stubScanRepo{},
	)

	got, err := svc.GetAttendancePolicy(context.Background(), "event-1")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.True(t, got.RequireQRForEntry)
	assert.False(t, got.AllowManualOverride)
}

// TestGetAttendanceSummary_ReturnsSummary tests summary aggregation.
func TestGetAttendanceSummary_ReturnsSummary(t *testing.T) {
	summary := &repository.AttendanceSummary{
		EventID:        "event-1",
		TotalAdmitted:  50,
		TotalDenied:    5,
		TotalCheckedIn: 50,
	}

	svc := service.NewAttendanceService(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{summary: summary},
	)

	got, err := svc.GetAttendanceSummary(context.Background(), "event-1")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, 50, got.TotalAdmitted)
	assert.Equal(t, 5, got.TotalDenied)
}

// TestGetAttendanceSummary_WS1_TotalCheckedInEqualsTotalAdmitted documents the
// WS1 contract: TotalCheckedIn always equals TotalAdmitted because no separate
// check-in scan result exists yet.  WS2 must update this test when a dedicated
// CHECK_IN result is introduced and the scan_repo computes them independently.
func TestGetAttendanceSummary_WS1_TotalCheckedInEqualsTotalAdmitted(t *testing.T) {
	const admitted = 17
	summary := &repository.AttendanceSummary{
		EventID:        "event-ws1",
		TotalAdmitted:  admitted,
		TotalDenied:    3,
		TotalCheckedIn: admitted, // WS1: same value as TotalAdmitted by design
	}

	svc := service.NewAttendanceService(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{summary: summary},
	)

	got, err := svc.GetAttendanceSummary(context.Background(), "event-ws1")
	require.NoError(t, err)
	assert.Equal(t, got.TotalAdmitted, got.TotalCheckedIn,
		"WS1: TotalCheckedIn must equal TotalAdmitted until WS2 adds a dedicated check-in event")
}

func TestListCheckedIn_ReturnsUsedCredentials(t *testing.T) {
	buyerID := "buyer-1"
	usedAt := time.Now().UTC()
	svc := service.NewAttendanceService(
		&stubCredentialRepo{checkedIn: []*repository.AdmissionCredential{
			{
				ID:          "cred-1",
				TicketID:    "event-1",
				EventID:     "event-1",
				BuyerUserID: &buyerID,
				Status:      repository.CredentialStatusUsed,
				UsedAt:      &usedAt,
			},
		}},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)

	rows, err := svc.ListCheckedIn(context.Background(), "event-1", 20)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "cred-1", rows[0].ID)
	assert.Equal(t, repository.CredentialStatusUsed, rows[0].Status)
}

func TestEnsureOrganizerOwnsEvent_OwnerMatch_ReturnsNil(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "organizer-1"},
	)
	err := svc.EnsureOrganizerOwnsEvent(context.Background(), "ticket-1", "organizer-1")
	require.NoError(t, err)
}

func TestEnsureOrganizerOwnsEvent_OwnerMismatch_ReturnsForbidden(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "organizer-1"},
	)
	err := svc.EnsureOrganizerOwnsEvent(context.Background(), "ticket-1", "other-user")
	require.Error(t, err)
	assert.True(t, errors.Is(err, service.ErrForbidden))
}

func TestEnsureOrganizerOwnsEvent_LookupNotFound_PropagatesNotFound(t *testing.T) {
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{err: repository.ErrNotFound},
	)
	err := svc.EnsureOrganizerOwnsEvent(context.Background(), "ticket-missing", "organizer-1")
	require.Error(t, err)
	assert.True(t, errors.Is(err, repository.ErrNotFound))
}
