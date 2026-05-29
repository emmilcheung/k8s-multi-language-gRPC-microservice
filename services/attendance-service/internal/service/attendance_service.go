// Package service defines the attendance service interface and stub implementation.
// Business logic for WS2+ is stubbed here; the interface is ready for injection.
package service

import (
	"context"
	"errors"
	"time"

	"github.com/acme/attendance-service/internal/repository"
	"github.com/google/uuid"
)

// ErrForbidden indicates the caller is authenticated but not authorized.
var ErrForbidden = errors.New("attendance service: forbidden")

// ErrPolicyBlock indicates the request was blocked by the event's attendance policy.
// Returned by CheckInByBuyer when allow_manual_override is false (or no policy row exists).
var ErrPolicyBlock = errors.New("attendance service: blocked by policy")

// AttendanceService is the core business logic boundary for the attendance domain.
type AttendanceService interface {
	// GetAdmissionPass returns the active credential for a ticket (optionally filtered by order).
	GetAdmissionPass(ctx context.Context, ticketID string, orderID *string) (*repository.AdmissionCredential, error)
	// GetAdmissionPassForBuyer returns an admission pass only if buyerUserID owns it.
	GetAdmissionPassForBuyer(ctx context.Context, ticketID string, orderID *string, buyerUserID string) (*repository.AdmissionCredential, error)
	// GetAdmissionPassByCredentialID returns a credential looked up by its primary key.
	// Used by the Apollo Federation entity resolver, which receives the credential ID.
	GetAdmissionPassByCredentialID(ctx context.Context, credentialID string) (*repository.AdmissionCredential, error)
	// GetAttendancePolicy returns the attendance policy for an event.
	GetAttendancePolicy(ctx context.Context, eventID string) (*repository.AttendancePolicy, error)
	// UpsertAttendancePolicy creates or updates the attendance policy for an event.
	UpsertAttendancePolicy(ctx context.Context, policy *repository.AttendancePolicy) error
	// GetAttendanceSummary returns aggregated scan counts for an event.
	GetAttendanceSummary(ctx context.Context, eventID string) (*repository.AttendanceSummary, error)
	// ListCheckedIn returns recently checked-in attendees for an event.
	ListCheckedIn(ctx context.Context, eventID string, limit int) ([]*repository.AdmissionCredential, error)
	// EnsureOrganizerOwnsEvent checks that organizerID owns the event resource.
	// WS3 derives eventID from ticketID, so this checks ticket ownership.
	EnsureOrganizerOwnsEvent(ctx context.Context, eventID, organizerID string) error
	TransferAdmissionCredential(
		ctx context.Context,
		credentialID, senderUserID, recipientEmail, requesterUserSig string,
	) (*repository.AdmissionCredential, *repository.AdmissionTransfer, error)
	RecallTransfer(ctx context.Context, credentialID, senderUserID string) (*repository.AdmissionCredential, error)
	AcceptTransfer(ctx context.Context, transferID, recipientUserID string) (*repository.AdmissionCredential, error)
	FindLatestTransferByCredentialID(ctx context.Context, credentialID string) (*repository.AdmissionTransfer, error)
}

// attendanceService is the concrete implementation wired with repository dependencies.
type attendanceService struct {
	credRepo     repository.CredentialRepository
	policyRepo   repository.PolicyRepository
	scanRepo     repository.ScanEventRepository
	ticketLookup TicketOwnerLookup
	userLookup   UserIdentityLookup
}

// NewAttendanceService creates an AttendanceService.
func NewAttendanceService(
	credRepo repository.CredentialRepository,
	policyRepo repository.PolicyRepository,
	scanRepo repository.ScanEventRepository,
) AttendanceService {
	return NewAttendanceServiceWithLookups(credRepo, policyRepo, scanRepo, nil, nil)
}

// NewAttendanceServiceWithTicketLookup creates an AttendanceService with ticket
// ownership lookup enabled for organizer policy authorization paths.
func NewAttendanceServiceWithTicketLookup(
	credRepo repository.CredentialRepository,
	policyRepo repository.PolicyRepository,
	scanRepo repository.ScanEventRepository,
	ticketLookup TicketOwnerLookup,
) AttendanceService {
	return NewAttendanceServiceWithLookups(credRepo, policyRepo, scanRepo, ticketLookup, nil)
}

// NewAttendanceServiceWithLookups creates an AttendanceService with optional
// ticket ownership and recipient identity lookup adapters.
func NewAttendanceServiceWithLookups(
	credRepo repository.CredentialRepository,
	policyRepo repository.PolicyRepository,
	scanRepo repository.ScanEventRepository,
	ticketLookup TicketOwnerLookup,
	userLookup UserIdentityLookup,
) AttendanceService {
	return &attendanceService{
		credRepo:     credRepo,
		policyRepo:   policyRepo,
		scanRepo:     scanRepo,
		ticketLookup: ticketLookup,
		userLookup:   userLookup,
	}
}

func (s *attendanceService) GetAdmissionPass(ctx context.Context, ticketID string, orderID *string) (*repository.AdmissionCredential, error) {
	if orderID != nil {
		return s.credRepo.FindByTicketAndOrder(ctx, ticketID, *orderID)
	}
	return s.credRepo.FindByTicketID(ctx, ticketID)
}

func (s *attendanceService) GetAdmissionPassForBuyer(
	ctx context.Context,
	ticketID string,
	orderID *string,
	buyerUserID string,
) (*repository.AdmissionCredential, error) {
	if buyerUserID == "" {
		return nil, ErrForbidden
	}

	var (
		cred *repository.AdmissionCredential
		err  error
	)
	if orderID != nil {
		cred, err = s.credRepo.FindByTicketAndOrder(ctx, ticketID, *orderID)
	} else {
		cred, err = s.credRepo.FindByTicketAndBuyer(ctx, ticketID, buyerUserID)
	}
	if err != nil {
		return nil, err
	}
	if cred.BuyerUserID == nil || *cred.BuyerUserID != buyerUserID {
		return nil, ErrForbidden
	}
	return cred, nil
}

func (s *attendanceService) GetAdmissionPassByCredentialID(ctx context.Context, credentialID string) (*repository.AdmissionCredential, error) {
	return s.credRepo.FindByID(ctx, credentialID)
}

func (s *attendanceService) GetAttendancePolicy(ctx context.Context, eventID string) (*repository.AttendancePolicy, error) {
	return s.policyRepo.FindByEventID(ctx, eventID)
}

func (s *attendanceService) UpsertAttendancePolicy(ctx context.Context, policy *repository.AttendancePolicy) error {
	return s.policyRepo.Upsert(ctx, policy)
}

func (s *attendanceService) GetAttendanceSummary(ctx context.Context, eventID string) (*repository.AttendanceSummary, error) {
	return s.scanRepo.SummarizeByEventID(ctx, eventID)
}

func (s *attendanceService) ListCheckedIn(
	ctx context.Context,
	eventID string,
	limit int,
) ([]*repository.AdmissionCredential, error) {
	return s.credRepo.ListCheckedInByEventID(ctx, eventID, limit)
}

func (s *attendanceService) EnsureOrganizerOwnsEvent(ctx context.Context, eventID, organizerID string) error {
	if organizerID == "" {
		return ErrForbidden
	}
	if s.ticketLookup == nil {
		// Fail closed: if ticket ownership cannot be resolved, the caller is not authorized.
		return ErrForbidden
	}
	ownerID, err := s.ticketLookup.LookupTicketOwner(ctx, eventID)
	if err != nil {
		return err
	}
	if ownerID != organizerID {
		return ErrForbidden
	}
	return nil
}

func (s *attendanceService) TransferAdmissionCredential(
	ctx context.Context,
	credentialID, senderUserID, recipientEmail, requesterUserSig string,
) (*repository.AdmissionCredential, *repository.AdmissionTransfer, error) {
	cred, err := s.credRepo.FindByID(ctx, credentialID)
	if err != nil {
		return nil, nil, err
	}
	if cred.BuyerUserID == nil || *cred.BuyerUserID != senderUserID {
		return nil, nil, ErrForbidden
	}
	if s.userLookup == nil {
		return nil, nil, ErrForbidden
	}

	recipientUserID, err := s.userLookup.LookupUserIDByEmail(ctx, recipientEmail, senderUserID, requesterUserSig)
	if err != nil {
		return nil, nil, err
	}
	if recipientUserID == senderUserID {
		return nil, nil, ErrForbidden
	}

	transfer := &repository.AdmissionTransfer{
		ID:              uuid.New().String(),
		CredentialID:    credentialID,
		SenderUserID:    senderUserID,
		RecipientUserID: &recipientUserID,
		RecipientEmail:  recipientEmail,
		State:           repository.TransferStatePending,
		CreatedAt:       time.Now().UTC(),
	}
	if err := s.credRepo.CreateTransfer(ctx, transfer); err != nil {
		return nil, nil, err
	}
	return cred, transfer, nil
}

func (s *attendanceService) RecallTransfer(
	ctx context.Context,
	credentialID, senderUserID string,
) (*repository.AdmissionCredential, error) {
	cred, err := s.credRepo.FindByID(ctx, credentialID)
	if err != nil {
		return nil, err
	}
	if cred.BuyerUserID == nil || *cred.BuyerUserID != senderUserID {
		return nil, ErrForbidden
	}
	if _, err := s.credRepo.RecallTransfer(ctx, credentialID, senderUserID, time.Now().UTC()); err != nil {
		return nil, err
	}
	return cred, nil
}

func (s *attendanceService) AcceptTransfer(
	ctx context.Context,
	transferID, recipientUserID string,
) (*repository.AdmissionCredential, error) {
	transfer, err := s.credRepo.FindTransferByID(ctx, transferID)
	if err != nil {
		return nil, err
	}
	if transfer.State != repository.TransferStatePending {
		return nil, repository.ErrNotFound
	}
	if transfer.RecipientUserID != nil && *transfer.RecipientUserID != recipientUserID {
		return nil, ErrForbidden
	}

	if _, err := s.credRepo.AcceptTransfer(ctx, transferID, recipientUserID, time.Now().UTC()); err != nil {
		return nil, err
	}
	return s.credRepo.FindByID(ctx, transfer.CredentialID)
}

func (s *attendanceService) FindLatestTransferByCredentialID(ctx context.Context, credentialID string) (*repository.AdmissionTransfer, error) {
	return s.credRepo.FindLatestTransferByCredentialID(ctx, credentialID)
}
