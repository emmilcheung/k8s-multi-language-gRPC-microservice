// Package service defines the attendance service interface and stub implementation.
// Business logic for WS2+ is stubbed here; the interface is ready for injection.
package service

import (
	"context"

	"github.com/acme/attendance-service/internal/repository"
)

// AttendanceService is the core business logic boundary for the attendance domain.
type AttendanceService interface {
	// GetAdmissionPass returns the active credential for a ticket (optionally filtered by order).
	GetAdmissionPass(ctx context.Context, ticketID string, orderID *string) (*repository.AdmissionCredential, error)
	// GetAdmissionPassByCredentialID returns a credential looked up by its primary key.
	// Used by the Apollo Federation entity resolver, which receives the credential ID.
	GetAdmissionPassByCredentialID(ctx context.Context, credentialID string) (*repository.AdmissionCredential, error)
	// GetAttendancePolicy returns the attendance policy for an event.
	GetAttendancePolicy(ctx context.Context, eventID string) (*repository.AttendancePolicy, error)
	// UpsertAttendancePolicy creates or updates the attendance policy for an event.
	UpsertAttendancePolicy(ctx context.Context, policy *repository.AttendancePolicy) error
	// GetAttendanceSummary returns aggregated scan counts for an event.
	GetAttendanceSummary(ctx context.Context, eventID string) (*repository.AttendanceSummary, error)
}

// attendanceService is the concrete implementation wired with repository dependencies.
type attendanceService struct {
	credRepo   repository.CredentialRepository
	policyRepo repository.PolicyRepository
	scanRepo   repository.ScanEventRepository
}

// NewAttendanceService creates an AttendanceService.
func NewAttendanceService(
	credRepo repository.CredentialRepository,
	policyRepo repository.PolicyRepository,
	scanRepo repository.ScanEventRepository,
) AttendanceService {
	return &attendanceService{
		credRepo:   credRepo,
		policyRepo: policyRepo,
		scanRepo:   scanRepo,
	}
}

func (s *attendanceService) GetAdmissionPass(ctx context.Context, ticketID string, orderID *string) (*repository.AdmissionCredential, error) {
	if orderID != nil {
		return s.credRepo.FindByTicketAndOrder(ctx, ticketID, *orderID)
	}
	return s.credRepo.FindByTicketID(ctx, ticketID)
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
