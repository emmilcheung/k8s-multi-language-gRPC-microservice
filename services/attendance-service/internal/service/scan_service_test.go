package service

import (
	"context"
	"testing"
	"time"

	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

type scanCredRepoDouble struct {
	cred      *repository.AdmissionCredential
	buyerCred *repository.AdmissionCredential
}

func (d *scanCredRepoDouble) FindByID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	if d.cred == nil {
		return nil, repository.ErrNotFound
	}
	return d.cred, nil
}

func (d *scanCredRepoDouble) FindByTicketID(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}
func (d *scanCredRepoDouble) FindByTicketAndBuyer(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	if d.buyerCred != nil {
		return d.buyerCred, nil
	}
	return nil, repository.ErrNotFound
}
func (d *scanCredRepoDouble) FindByTicketAndOrder(_ context.Context, _, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}
func (d *scanCredRepoDouble) FindByIssuanceKey(_ context.Context, _ string) (*repository.AdmissionCredential, error) {
	return nil, repository.ErrNotFound
}
func (d *scanCredRepoDouble) CreateWithOutbox(_ context.Context, _ *repository.AdmissionCredential, _ *repository.OutboxRow) error {
	return nil
}
func (d *scanCredRepoDouble) Create(_ context.Context, _ *repository.AdmissionCredential) error { return nil }
func (d *scanCredRepoDouble) ConsumeIssued(
	_ context.Context,
	_ string,
	usedAt time.Time,
	scannerUserID, deviceID string,
) (*repository.AdmissionCredential, bool, error) {
	target := d.cred
	if target == nil {
		target = d.buyerCred
	}
	if target == nil {
		return nil, false, repository.ErrNotFound
	}
	if target.Status != repository.CredentialStatusIssued {
		return target, false, nil
	}
	target.Status = repository.CredentialStatusUsed
	target.UsedAt = &usedAt
	target.UsedByUserID = &scannerUserID
	target.UsedByDeviceID = &deviceID
	return target, true, nil
}
func (d *scanCredRepoDouble) UpdateStatus(_ context.Context, _ string, _ repository.CredentialStatus) error {
	return nil
}
func (d *scanCredRepoDouble) MarkEventPublished(_ context.Context, _ string, _ time.Time) error { return nil }
func (d *scanCredRepoDouble) ListCheckedInByEventID(_ context.Context, _ string, _ int) ([]*repository.AdmissionCredential, error) {
	return []*repository.AdmissionCredential{}, nil
}

type scanRepoDouble struct {
	events []*repository.ScanEvent
}

func (d *scanRepoDouble) Create(_ context.Context, ev *repository.ScanEvent) error {
	d.events = append(d.events, ev)
	return nil
}
func (d *scanRepoDouble) SummarizeByEventID(_ context.Context, eventID string) (*repository.AttendanceSummary, error) {
	return &repository.AttendanceSummary{EventID: eventID}, nil
}

func newScanSvc(t *testing.T, cred *repository.AdmissionCredential, scanRepo *scanRepoDouble) ScanService {
	t.Helper()
	gen := qr.NewGenerator("test-signing-key-that-is-at-least-32-characters")
	return NewScanService(&scanCredRepoDouble{cred: cred}, scanRepo, gen, zap.NewNop())
}

func signedToken(t *testing.T, credentialID, eventID string, version int) string {
	t.Helper()
	gen := qr.NewGenerator("test-signing-key-that-is-at-least-32-characters")
	token, err := gen.Generate(qr.Claims{
		V:            1,
		CredentialID: credentialID,
		TicketID:     "ticket-1",
		EventID:      eventID,
		TokenVersion: version,
		IssuedAt:     time.Now().UTC(),
		ExpiresAt:    time.Now().UTC().Add(time.Hour),
	})
	require.NoError(t, err)
	return token
}

func TestScanService_Validate_DoesNotConsumeCredential(t *testing.T) {
	cred := &repository.AdmissionCredential{
		ID:           "cred-1",
		EventID:      "event-1",
		TokenVersion: 1,
		Status:       repository.CredentialStatusIssued,
	}
	scans := &scanRepoDouble{}
	svc := newScanSvc(t, cred, scans)

	outcome, err := svc.Validate(context.Background(), signedToken(t, "cred-1", "event-1", 1), "event-1", "scanner-1", "device-1", nil)
	require.NoError(t, err)
	assert.Equal(t, ScanResultValid, outcome.Result)
	assert.Equal(t, repository.CredentialStatusIssued, cred.Status)
}

func TestScanService_CheckIn_FirstSucceeds_SecondAlreadyUsed(t *testing.T) {
	cred := &repository.AdmissionCredential{
		ID:           "cred-1",
		EventID:      "event-1",
		TokenVersion: 1,
		Status:       repository.CredentialStatusIssued,
	}
	scans := &scanRepoDouble{}
	svc := newScanSvc(t, cred, scans)
	token := signedToken(t, "cred-1", "event-1", 1)

	first, err := svc.CheckIn(context.Background(), token, "event-1", "scanner-1", "device-1", nil)
	require.NoError(t, err)
	assert.Equal(t, ScanResultValid, first.Result)

	second, err := svc.CheckIn(context.Background(), token, "event-1", "scanner-1", "device-1", nil)
	require.NoError(t, err)
	assert.Equal(t, ScanResultAlreadyUsed, second.Result)
}

func TestScanService_CheckIn_RevokedRejected(t *testing.T) {
	cred := &repository.AdmissionCredential{
		ID:           "cred-1",
		EventID:      "event-1",
		TokenVersion: 1,
		Status:       repository.CredentialStatusRevoked,
	}
	svc := newScanSvc(t, cred, &scanRepoDouble{})

	outcome, err := svc.CheckIn(context.Background(), signedToken(t, "cred-1", "event-1", 1), "event-1", "scanner-1", "device-1", nil)
	require.NoError(t, err)
	assert.Equal(t, ScanResultRevoked, outcome.Result)
}

func TestScanService_Validate_WrongEventRejected(t *testing.T) {
	cred := &repository.AdmissionCredential{
		ID:           "cred-1",
		EventID:      "event-1",
		TokenVersion: 1,
		Status:       repository.CredentialStatusIssued,
	}
	svc := newScanSvc(t, cred, &scanRepoDouble{})

	outcome, err := svc.Validate(context.Background(), signedToken(t, "cred-1", "event-1", 1), "event-2", "scanner-1", "device-1", nil)
	require.NoError(t, err)
	assert.Equal(t, ScanResultWrongEvent, outcome.Result)
}

func TestValidate_RecordsValidatedResult(t *testing.T) {
	cred := &repository.AdmissionCredential{
		ID:           "cred-1",
		EventID:      "event-1",
		TokenVersion: 1,
		Status:       repository.CredentialStatusIssued,
	}
	scans := &scanRepoDouble{}
	svc := newScanSvc(t, cred, scans)

	outcome, err := svc.Validate(context.Background(), signedToken(t, "cred-1", "event-1", 1), "event-1", "scanner-1", "device-1", nil)
	require.NoError(t, err)
	assert.Equal(t, ScanResultValid, outcome.Result)

	// Exactly one scan event must be recorded.
	require.Len(t, scans.events, 1, "expected exactly one scan_event to be recorded")
	// The recorded result must be VALIDATED, not ADMITTED, so validate-mode scans
	// do not inflate total_admitted / total_checked_in in GetEventSummary.
	assert.Equal(t, repository.ScanResultValidated, scans.events[0].Result,
		"validate-mode scan must record VALIDATED, not ADMITTED")
}

func TestScanService_CheckInByBuyer_ConsumesIssuedCredential(t *testing.T) {
	buyerID := "buyer-1"
	cred := &repository.AdmissionCredential{
		ID:           "cred-1",
		TicketID:     "event-1",
		EventID:      "event-1",
		BuyerUserID:  &buyerID,
		TokenVersion: 1,
		Status:       repository.CredentialStatusIssued,
	}
	scans := &scanRepoDouble{}
	gen := qr.NewGenerator("test-signing-key-that-is-at-least-32-characters")
	svc := NewScanService(&scanCredRepoDouble{buyerCred: cred}, scans, gen, zap.NewNop())

	outcome, err := svc.CheckInByBuyer(context.Background(), "event-1", buyerID, "scanner-1", "device-1", nil)
	require.NoError(t, err)
	assert.Equal(t, ScanResultValid, outcome.Result)
	assert.Equal(t, repository.CredentialStatusUsed, cred.Status)
}
