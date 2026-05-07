package test

import (
	"context"
	"testing"
	"time"

	gqlgraph "github.com/acme/attendance-service/internal/graphql"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/acme/attendance-service/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGraphQL_AdmissionPass_ReturnsNil_WhenNotFound(t *testing.T) {
	svc := service.NewAttendanceService(
		&stubCredentialRepo{err: repository.ErrNotFound},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)

	resolver := &gqlgraph.Resolver{Svc: svc}
	qr := resolver.Query()

	result, err := qr.AdmissionPass(context.Background(), "ticket-x", nil)
	require.NoError(t, err)
	assert.Nil(t, result, "expected nil for not-found ticket")
}

func TestGraphQL_AdmissionPass_ReturnsPass_WhenFound(t *testing.T) {
	now := time.Now()
	cred := &repository.AdmissionCredential{
		ID:       "cred-gql-1",
		TicketID: "ticket-gql-1",
		OrderID:  "order-gql-1",
		EventID:  "event-gql-1",
		Status:   repository.CredentialStatusIssued,
		IssuedAt: now,
	}

	svc := service.NewAttendanceService(
		&stubCredentialRepo{credential: cred},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)

	resolver := &gqlgraph.Resolver{Svc: svc}
	qr := resolver.Query()

	result, err := qr.AdmissionPass(context.Background(), "ticket-gql-1", nil)
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "cred-gql-1", result.ID)
	assert.Equal(t, gqlgraph.CredentialStatusIssued, result.Status)
	assert.Equal(t, "ticket-gql-1", result.TicketID)
}

func TestGraphQL_AttendancePolicy_ReturnsNil_WhenNotFound(t *testing.T) {
	svc := service.NewAttendanceService(
		&stubCredentialRepo{},
		&stubPolicyRepo{err: repository.ErrNotFound},
		&stubScanRepo{},
	)

	resolver := &gqlgraph.Resolver{Svc: svc}
	qr := resolver.Query()

	result, err := qr.AttendancePolicy(context.Background(), "event-missing")
	require.NoError(t, err)
	assert.Nil(t, result)
}

func TestGraphQL_AttendancePolicy_ReturnsPolicy_WhenFound(t *testing.T) {
	policy := &repository.AttendancePolicy{
		EventID:             "event-gql-2",
		RequireQRForEntry:   true,
		AllowManualOverride: false,
	}

	svc := service.NewAttendanceService(
		&stubCredentialRepo{},
		&stubPolicyRepo{policy: policy},
		&stubScanRepo{},
	)

	resolver := &gqlgraph.Resolver{Svc: svc}
	qr := resolver.Query()

	result, err := qr.AttendancePolicy(context.Background(), "event-gql-2")
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "event-gql-2", result.EventID)
	assert.True(t, result.RequireQRForEntry)
}

func TestGraphQL_AttendanceSummary_ReturnsSummary(t *testing.T) {
	summary := &repository.AttendanceSummary{
		EventID:        "event-gql-3",
		TotalAdmitted:  100,
		TotalDenied:    10,
		TotalCheckedIn: 100,
	}

	svc := service.NewAttendanceService(
		&stubCredentialRepo{},
		&stubPolicyRepo{},
		&stubScanRepo{summary: summary},
	)

	resolver := &gqlgraph.Resolver{Svc: svc}
	qr := resolver.Query()

	result, err := qr.AttendanceSummary(context.Background(), "event-gql-3")
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "event-gql-3", result.EventID)
	assert.Equal(t, 100, result.TotalAdmitted)
	assert.Equal(t, 10, result.TotalDenied)
}

// TestEntityResolver_FindAdmissionPassByID_QueriesByCredentialID verifies
// that entity resolution uses the credential's primary key (id), not ticketId.
// The stub records which key was supplied so that accidentally routing through
// FindByTicketID would produce a recognizably wrong result.
func TestEntityResolver_FindAdmissionPassByID_QueriesByCredentialID(t *testing.T) {
	const credentialID = "cred-entity-1"
	const ticketID = "ticket-DIFFERENT"

	now := time.Now()
	cred := &repository.AdmissionCredential{
		ID:       credentialID,
		TicketID: ticketID,
		OrderID:  "order-entity-1",
		EventID:  "event-entity-1",
		Status:   repository.CredentialStatusIssued,
		IssuedAt: now,
	}

	// spy captures which key was used for the lookup
	spy := &spyCredentialRepo{credential: cred}
	svc := service.NewAttendanceService(spy, &stubPolicyRepo{}, &stubScanRepo{})

	resolver := &gqlgraph.Resolver{Svc: svc}
	entity := resolver.Entity()

	result, err := entity.FindAdmissionPassByID(context.Background(), credentialID)
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, credentialID, result.ID)

	// The critical assertion: lookup MUST have used the credential ID, not the
	// ticket ID.  If the resolver mistakenly called FindByTicketID the spy
	// would record ticketID here.
	assert.Equal(t, credentialID, spy.lastFindByIDKey,
		"entity resolver must call FindByID with the credential primary key, not the ticket key")
	assert.Empty(t, spy.lastFindByTicketIDKey,
		"entity resolver must NOT call FindByTicketID")
}

// TestEntityResolver_FindAdmissionPassByID_ReturnsNil_WhenNotFound verifies
// the resolver propagates ErrNotFound as a nil result (Apollo federation
// semantics).
func TestEntityResolver_FindAdmissionPassByID_ReturnsNil_WhenNotFound(t *testing.T) {
	svc := service.NewAttendanceService(
		&stubCredentialRepo{err: repository.ErrNotFound},
		&stubPolicyRepo{},
		&stubScanRepo{},
	)

	resolver := &gqlgraph.Resolver{Svc: svc}
	entity := resolver.Entity()

	result, err := entity.FindAdmissionPassByID(context.Background(), "missing-id")
	require.NoError(t, err)
	assert.Nil(t, result)
}

// spyCredentialRepo records which lookup method was called and with what key.
type spyCredentialRepo struct {
	credential           *repository.AdmissionCredential
	err                  error
	lastFindByIDKey      string
	lastFindByTicketIDKey string
}

func (s *spyCredentialRepo) FindByID(_ context.Context, id string) (*repository.AdmissionCredential, error) {
	s.lastFindByIDKey = id
	return s.credential, s.err
}

func (s *spyCredentialRepo) FindByTicketID(_ context.Context, ticketID string) (*repository.AdmissionCredential, error) {
	s.lastFindByTicketIDKey = ticketID
	return s.credential, s.err
}

func (s *spyCredentialRepo) FindByTicketAndOrder(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	return s.credential, s.err
}

func (s *spyCredentialRepo) FindByIssuanceKey(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return s.credential, s.err
}

func (s *spyCredentialRepo) Create(_ context.Context, _ *repository.AdmissionCredential) error {
	return s.err
}

func (s *spyCredentialRepo) UpdateStatus(_ context.Context, _ string, _ repository.CredentialStatus) error {
	return s.err
}
