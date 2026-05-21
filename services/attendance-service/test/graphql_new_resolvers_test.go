package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	gqlgraph "github.com/acme/attendance-service/internal/graphql"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/security"
	"github.com/acme/attendance-service/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// contextWithUserID creates a context that carries the given user ID via HTTP request header.
func contextWithUserID(userID string) context.Context {
	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	if userID != "" {
		req.Header.Set("X-User-Id", userID)
	}
	return gqlgraph.WithHTTPRequest(context.Background(), req)
}

// --- attendanceSummary ---

func TestGraphQL_AttendanceSummary_RequiresOrganizerIdentity(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	_, err := resolver.Query().AttendanceSummary(context.Background(), "event-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

func TestGraphQL_AttendanceSummary_RequiresOwnership(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{
		checkErr: service.ErrForbidden,
	}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	_, err := resolver.Query().AttendanceSummary(contextWithUserID("organizer-2"), "event-secure")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")
}

func TestGraphQL_AttendancePolicy_RequiresOrganizerIdentity(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	_, err := resolver.Query().AttendancePolicy(context.Background(), "event-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

func TestGraphQL_AttendancePolicy_RequiresOwnership(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{
		checkErr: service.ErrForbidden,
	}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	_, err := resolver.Query().AttendancePolicy(contextWithUserID("organizer-2"), "event-secure")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")
}

// --- eventCheckins ---

func TestGraphQL_EventCheckins_ReturnsEmpty(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	result, err := resolver.Query().EventCheckins(contextWithUserID("organizer-1"), "event-1", nil, nil)
	require.NoError(t, err)
	assert.Empty(t, result)
}

func TestGraphQL_EventCheckins_ReturnsMappedList(t *testing.T) {
	now := time.Now()
	usedAt := now.Add(-1 * time.Hour)
	creds := []*repository.AdmissionCredential{
		{
			ID:       "cred-1",
			TicketID: "ticket-1",
			OrderID:  "order-1",
			EventID:  "event-2",
			Status:   repository.CredentialStatusUsed,
			IssuedAt: now,
			UsedAt:   &usedAt,
		},
	}
	svc := &stubAttendanceSvcWithCheckedIn{creds: creds}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	result, err := resolver.Query().EventCheckins(contextWithUserID("organizer-1"), "event-2", nil, nil)
	require.NoError(t, err)
	require.Len(t, result, 1)
	assert.Equal(t, "cred-1", result[0].ID)
	assert.Equal(t, "event-2", result[0].EventID)
	assert.Equal(t, "ticket-1", result[0].TicketID)
	assert.Equal(t, "order-1", result[0].OrderID)
	assert.Equal(t, gqlgraph.CheckinSourceQRScan, result[0].Source)
	assert.NotEmpty(t, result[0].CheckedInAt)
}

func TestGraphQL_EventCheckins_RequiresOrganizerOwnership(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{
		checkErr: service.ErrForbidden,
	}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}

	ctx := contextWithUserID("organizer-2")
	_, err := resolver.Query().EventCheckins(ctx, "event-secure", nil, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")
}

func TestGraphQL_EventCheckins_RejectsUnsupportedCursor(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	after := "opaque-cursor"
	_, err := resolver.Query().EventCheckins(contextWithUserID("organizer-1"), "event-1", nil, &after)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "pagination cursor is not yet supported")
}

func TestGraphQL_EventCheckins_CapsRequestedPageSize(t *testing.T) {
	svc := &stubAttendanceSvcWithCheckedIn{}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	first := 1000
	_, err := resolver.Query().EventCheckins(contextWithUserID("organizer-1"), "event-1", &first, nil)
	require.NoError(t, err)
	assert.Equal(t, 500, svc.lastLimit)
}

// --- updateAttendancePolicy ---

func TestGraphQL_UpdateAttendancePolicy_RequiresAuth(t *testing.T) {
	svc := service.NewAttendanceService(&stubCredentialRepo{}, &stubPolicyRepo{}, &stubScanRepo{})
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	_, err := resolver.Mutation().UpdateAttendancePolicy(context.Background(), "event-1", gqlgraph.UpdateAttendancePolicyInput{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

func TestGraphQL_UpdateAttendancePolicy_CreatesPolicy(t *testing.T) {
	req := require.New(t)
	policyRepo := &stubPolicyRepoWithUpsert{}

	// Use a stub attendance service that allows all ownership checks.
	svc := &stubAttendanceSvcWithPolicyRepo{policyRepo: policyRepo}
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}

	trueVal := true
	ctx := contextWithUserID("organizer-1")
	result, err := resolver.Mutation().UpdateAttendancePolicy(ctx, "event-3", gqlgraph.UpdateAttendancePolicyInput{
		RequireQRForEntry: &trueVal,
	})
	req.NoError(err)
	req.NotNil(result)
	assert.Equal(t, "event-3", result.EventID)
	assert.True(t, result.RequireQRForEntry)
}

// --- validateScan ---

func TestGraphQL_ValidateScan_RequiresAuth(t *testing.T) {
	svc := service.NewAttendanceService(&stubCredentialRepo{}, &stubPolicyRepo{}, &stubScanRepo{})
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	_, err := resolver.Mutation().ValidateScan(context.Background(), "some-token")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

func TestGraphQL_ValidateScan_ReturnsValidResult(t *testing.T) {
	outcome := &service.ScanOutcome{
		Result:       service.ScanResultValid,
		CredentialID: "cred-v1",
		EventID:      "event-v1",
	}
	cred := &repository.AdmissionCredential{
		ID:       "cred-v1",
		TicketID: "ticket-v1",
		OrderID:  "order-v1",
		EventID:  "event-v1",
		Status:   repository.CredentialStatusUsed,
		IssuedAt: time.Now(),
	}
	svc := service.NewAttendanceService(&stubCredentialRepo{credential: cred}, &stubPolicyRepo{}, &stubScanRepo{})
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{outcome: outcome}}

	ctx := contextWithUserID("scanner-1")
	result, err := resolver.Mutation().ValidateScan(ctx, "valid-token")
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.True(t, result.Valid)
	assert.Nil(t, result.Reason)
}

func TestGraphQL_ValidateScan_ReturnsInvalidResult(t *testing.T) {
	outcome := &service.ScanOutcome{
		Result: service.ScanResultInvalidSignature,
	}
	svc := service.NewAttendanceService(&stubCredentialRepo{}, &stubPolicyRepo{}, &stubScanRepo{})
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{outcome: outcome}}

	ctx := contextWithUserID("scanner-1")
	result, err := resolver.Mutation().ValidateScan(ctx, "bad-token")
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.False(t, result.Valid)
	require.NotNil(t, result.Reason)
	assert.Equal(t, string(service.ScanResultInvalidSignature), *result.Reason)
}

// --- recordCheckinByUserId ---

func TestGraphQL_RecordCheckinByUserID_RequiresAuth(t *testing.T) {
	svc := service.NewAttendanceService(&stubCredentialRepo{}, &stubPolicyRepo{}, &stubScanRepo{})
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}
	_, err := resolver.Mutation().RecordCheckinByUserID(context.Background(), gqlgraph.RecordCheckinByUserIDInput{
		EventID: "event-1",
		UserID:  "user-1",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unauthorized")
}

func TestGraphQL_RecordCheckinByUserID_SuccessfulCheckin(t *testing.T) {
	now := time.Now()
	usedAt := now
	cred := &repository.AdmissionCredential{
		ID:          "cred-ci1",
		TicketID:    "ticket-ci1",
		OrderID:     "order-ci1",
		EventID:     "event-ci1",
		BuyerUserID: strPtr("user-ci1"),
		Status:      repository.CredentialStatusUsed,
		IssuedAt:    now,
		UsedAt:      &usedAt,
	}
	outcome := &service.ScanOutcome{
		Result:       service.ScanResultValid,
		CredentialID: "cred-ci1",
		EventID:      "event-ci1",
	}
	policy := &repository.AttendancePolicy{
		EventID:             "event-ci1",
		AllowManualOverride: true,
	}
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{policy: policy},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "scanner-1"},
	)
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{outcome: outcome}}

	ctx := contextWithUserID("scanner-1")
	result, err := resolver.Mutation().RecordCheckinByUserID(ctx, gqlgraph.RecordCheckinByUserIDInput{
		EventID: "event-ci1",
		UserID:  "user-ci1",
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "cred-ci1", result.ID)
	assert.Equal(t, gqlgraph.CheckinSourceUserIDLookup, result.Source)
}

func TestGraphQL_RecordCheckin_RequiresOrganizerOwnership(t *testing.T) {
	now := time.Now()
	buyerID := "buyer-ci1"
	cred := &repository.AdmissionCredential{
		ID:          "cred-ci2",
		TicketID:    "ticket-ci2",
		OrderID:     "order-ci2",
		EventID:     "event-ci2",
		BuyerUserID: &buyerID,
		Status:      repository.CredentialStatusIssued,
		IssuedAt:    now,
	}
	policy := &repository.AttendancePolicy{
		EventID:             "event-ci2",
		AllowManualOverride: true,
	}
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{policy: policy},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "different-organizer"},
	)
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}

	_, err := resolver.Mutation().RecordCheckin(contextWithUserID("scanner-1"), gqlgraph.RecordCheckinInput{
		TicketID: "ticket-ci2",
		Source:   gqlgraph.CheckinSourceManualOverride,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")
}

func TestGraphQL_RecordCheckin_SuccessfulCheckin(t *testing.T) {
	now := time.Now()
	usedAt := now
	buyerID := "buyer-ci4"
	cred := &repository.AdmissionCredential{
		ID:          "cred-ci4",
		TicketID:    "ticket-ci4",
		OrderID:     "order-ci4",
		EventID:     "event-ci4",
		BuyerUserID: &buyerID,
		Status:      repository.CredentialStatusUsed,
		IssuedAt:    now.Add(-1 * time.Hour),
		UsedAt:      &usedAt,
	}
	outcome := &service.ScanOutcome{
		Result:       service.ScanResultValid,
		CredentialID: "cred-ci4",
		EventID:      "event-ci4",
	}
	policy := &repository.AttendancePolicy{
		EventID:             "event-ci4",
		AllowManualOverride: true,
	}
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{policy: policy},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "scanner-1"},
	)
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{outcome: outcome}}

	result, err := resolver.Mutation().RecordCheckin(contextWithUserID("scanner-1"), gqlgraph.RecordCheckinInput{
		TicketID: "ticket-ci4",
		Source:   gqlgraph.CheckinSourceManualOverride,
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "cred-ci4", result.ID)
	assert.Equal(t, "ticket-ci4", result.TicketID)
	assert.Equal(t, "order-ci4", result.OrderID)
	assert.Equal(t, gqlgraph.CheckinSourceManualOverride, result.Source)
	assert.Equal(t, usedAt.Format("2006-01-02T15:04:05Z07:00"), result.CheckedInAt)
}

func TestGraphQL_RecordCheckin_RejectsUserIDLookupSource(t *testing.T) {
	now := time.Now()
	buyerID := "buyer-ci5"
	cred := &repository.AdmissionCredential{
		ID:          "cred-ci5",
		TicketID:    "ticket-ci5",
		OrderID:     "order-ci5",
		EventID:     "event-ci5",
		BuyerUserID: &buyerID,
		Status:      repository.CredentialStatusIssued,
		IssuedAt:    now,
	}
	policy := &repository.AttendancePolicy{
		EventID:             "event-ci5",
		AllowManualOverride: true,
	}
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{policy: policy},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "scanner-1"},
	)
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}

	_, err := resolver.Mutation().RecordCheckin(contextWithUserID("scanner-1"), gqlgraph.RecordCheckinInput{
		TicketID: "ticket-ci5",
		Source:   gqlgraph.CheckinSourceUserIDLookup,
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid source")
}

func TestGraphQL_RecordCheckinByUserID_RequiresOrganizerOwnership(t *testing.T) {
	policy := &repository.AttendancePolicy{
		EventID:             "event-ci3",
		AllowManualOverride: true,
	}
	svc := service.NewAttendanceServiceWithTicketLookup(
		&stubCredentialRepo{},
		&stubPolicyRepo{policy: policy},
		&stubScanRepo{},
		&stubTicketOwnerLookupSvc{ownerID: "different-organizer"},
	)
	resolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: &stubScanService{}}

	_, err := resolver.Mutation().RecordCheckinByUserID(contextWithUserID("scanner-1"), gqlgraph.RecordCheckinByUserIDInput{
		EventID: "event-ci3",
		UserID:  "user-ci3",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "forbidden")
}

// --- auth wrapper ---

func TestGraphQL_WrapWithUserIDSignatureValidation_AllowsUnauthenticated(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("test-signing-key-abc123xyz456789")
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := gqlgraph.WrapWithUserIDSignatureValidation(base, validator)

	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGraphQL_WrapWithUserIDSignatureValidation_RejectsUserWithoutSig(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("test-signing-key-abc123xyz456789")
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := gqlgraph.WrapWithUserIDSignatureValidation(base, validator)

	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	req.Header.Set("X-User-Id", "user-123")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestGraphQL_WrapWithUserIDSignatureValidation_RejectsInvalidSig(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("test-signing-key-abc123xyz456789")
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := gqlgraph.WrapWithUserIDSignatureValidation(base, validator)

	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	req.Header.Set("X-User-Id", "user-123")
	req.Header.Set("X-User-Id-Sig", "bad-signature")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestGraphQL_WrapWithUserIDSignatureValidation_EmptyKeyAllowsAll(t *testing.T) {
	validator := security.NewUserIDSignatureValidator("")
	base := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := gqlgraph.WrapWithUserIDSignatureValidation(base, validator)

	req := httptest.NewRequest(http.MethodPost, "/graphql", nil)
	req.Header.Set("X-User-Id", "user-123")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

// --- helpers ---

func strPtr(s string) *string { return &s }

// stubCredentialRepoWithList returns a fixed list from ListCheckedInByEventID.
type stubCredentialRepoWithList struct {
	stubCredentialRepo
	creds []*repository.AdmissionCredential
}

func (s *stubCredentialRepoWithList) ListCheckedInByEventID(_ context.Context, _ string, _ int) ([]*repository.AdmissionCredential, error) {
	return s.creds, nil
}

// stubPolicyRepoWithUpsert records upserted policy and returns a preset one on find.
type stubPolicyRepoWithUpsert struct {
	policy   *repository.AttendancePolicy
	upserted *repository.AttendancePolicy
}

func (s *stubPolicyRepoWithUpsert) FindByEventID(_ context.Context, _ string) (*repository.AttendancePolicy, error) {
	if s.policy == nil {
		return nil, repository.ErrNotFound
	}
	return s.policy, nil
}

func (s *stubPolicyRepoWithUpsert) Upsert(_ context.Context, p *repository.AttendancePolicy) error {
	s.upserted = p
	s.policy = p
	return nil
}

type stubAttendanceSvcWithCheckedIn struct {
	creds    []*repository.AdmissionCredential
	checkErr error
	lastLimit int
}

func (s *stubAttendanceSvcWithCheckedIn) GetAdmissionPass(_ context.Context, _ string, _ *string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}

func (s *stubAttendanceSvcWithCheckedIn) GetAdmissionPassForBuyer(_ context.Context, _ string, _ *string, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}

func (s *stubAttendanceSvcWithCheckedIn) GetAdmissionPassByCredentialID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}

func (s *stubAttendanceSvcWithCheckedIn) GetAttendancePolicy(_ context.Context, _ string) (*repository.AttendancePolicy, error) {
	return nil, repository.ErrNotFound
}

func (s *stubAttendanceSvcWithCheckedIn) UpsertAttendancePolicy(_ context.Context, _ *repository.AttendancePolicy) error {
	return nil
}

func (s *stubAttendanceSvcWithCheckedIn) GetAttendanceSummary(_ context.Context, _ string) (*repository.AttendanceSummary, error) {
	return &repository.AttendanceSummary{}, nil
}

func (s *stubAttendanceSvcWithCheckedIn) ListCheckedIn(_ context.Context, _ string, limit int) ([]*repository.AdmissionCredential, error) {
	s.lastLimit = limit
	return s.creds, nil
}

func (s *stubAttendanceSvcWithCheckedIn) EnsureOrganizerOwnsEvent(_ context.Context, _, _ string) error {
	return s.checkErr
}

// stubAttendanceSvcWithPolicyRepo is a minimal AttendanceService stub that allows
// all ownership checks and delegates policy operations to the provided repo.
type stubAttendanceSvcWithPolicyRepo struct {
	policyRepo *stubPolicyRepoWithUpsert
	cred       *repository.AdmissionCredential
}

func (s *stubAttendanceSvcWithPolicyRepo) GetAdmissionPass(_ context.Context, _ string, _ *string) (*repository.AdmissionCredential, error) {
	if s.cred == nil {
		return nil, repository.ErrNotFound
	}
	return s.cred, nil
}

func (s *stubAttendanceSvcWithPolicyRepo) GetAdmissionPassForBuyer(_ context.Context, _ string, _ *string, _ string) (*repository.AdmissionCredential, error) {
	return s.cred, nil
}

func (s *stubAttendanceSvcWithPolicyRepo) GetAdmissionPassByCredentialID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	if s.cred == nil {
		return nil, repository.ErrNotFound
	}
	return s.cred, nil
}

func (s *stubAttendanceSvcWithPolicyRepo) GetAttendancePolicy(ctx context.Context, eventID string) (*repository.AttendancePolicy, error) {
	return s.policyRepo.FindByEventID(ctx, eventID)
}

func (s *stubAttendanceSvcWithPolicyRepo) UpsertAttendancePolicy(ctx context.Context, policy *repository.AttendancePolicy) error {
	return s.policyRepo.Upsert(ctx, policy)
}

func (s *stubAttendanceSvcWithPolicyRepo) GetAttendanceSummary(_ context.Context, _ string) (*repository.AttendanceSummary, error) {
	return &repository.AttendanceSummary{}, nil
}

func (s *stubAttendanceSvcWithPolicyRepo) ListCheckedIn(_ context.Context, _ string, _ int) ([]*repository.AdmissionCredential, error) {
	return nil, nil
}

func (s *stubAttendanceSvcWithPolicyRepo) EnsureOrganizerOwnsEvent(_ context.Context, _, _ string) error {
	return nil // always allow in tests
}
