// Package repository defines data-access interfaces for attendance-service.
// Concrete implementations live in repository/postgres.
package repository

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound is returned by repositories when a record does not exist.
var ErrNotFound = errors.New("repository: record not found")

// CredentialStatus mirrors the database constraint enum.
type CredentialStatus string

const (
	CredentialStatusIssued  CredentialStatus = "ISSUED"
	CredentialStatusUsed    CredentialStatus = "USED"
	CredentialStatusRevoked CredentialStatus = "REVOKED"
	CredentialStatusExpired CredentialStatus = "EXPIRED"
)

// ScanMode mirrors the database constraint enum.
type ScanMode string

const (
	ScanModeQR     ScanMode = "QR"
	ScanModeManual ScanMode = "MANUAL"
)

// ScanResult mirrors the database constraint enum.
type ScanResult string

const (
	ScanResultAdmitted     ScanResult = "ADMITTED"
	ScanResultDenied       ScanResult = "DENIED"
	ScanResultAlreadyUsed  ScanResult = "ALREADY_USED"
	ScanResultInvalidToken ScanResult = "INVALID_TOKEN"
	ScanResultPolicyBlock  ScanResult = "POLICY_BLOCK"
)

// AdmissionCredential is the domain object for an issued admission credential.
type AdmissionCredential struct {
	ID             string
	TicketID       string
	OrderID        string
	EventID        string
	TokenVersion   int
	TokenID        string
	// IssuanceKey is the deterministic per-admission-unit key used for idempotent
	// duplicate detection.  See migration 002 for derivation rules.
	IssuanceKey    string
	Status         CredentialStatus
	IssuedAt       time.Time
	RevokedAt      *time.Time
	UsedAt         *time.Time
	UsedByUserID   *string
	UsedByDeviceID *string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// AttendancePolicy is the domain object for an event-level attendance policy.
type AttendancePolicy struct {
	ID                  string
	EventID             string
	TicketID            *string
	OrganizerID         string
	RequireQRForEntry   bool
	AllowManualOverride bool
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// ScanEvent is the domain object for a single scan attempt.
type ScanEvent struct {
	ID            string
	CredentialID  *string
	EventID       string
	ScannerUserID string
	DeviceID      string
	GateID        *string
	Mode          ScanMode
	Result        ScanResult
	RawTokenHash  *string
	ScannedAt     time.Time
	CreatedAt     time.Time
}

// AttendanceSummary aggregates scan event counts for an event.
type AttendanceSummary struct {
	EventID       string
	TotalAdmitted int
	TotalDenied   int
	TotalCheckedIn int
}

// CredentialRepository manages admission credentials.
type CredentialRepository interface {
	FindByID(ctx context.Context, id string) (*AdmissionCredential, error)
	FindByTicketID(ctx context.Context, ticketID string) (*AdmissionCredential, error)
	FindByTicketAndOrder(ctx context.Context, ticketID, orderID string) (*AdmissionCredential, error)
	// FindByIssuanceKey returns the credential for the given idempotency key.
	// Returns ErrNotFound if no credential exists for the key.
	FindByIssuanceKey(ctx context.Context, issuanceKey string) (*AdmissionCredential, error)
	Create(ctx context.Context, cred *AdmissionCredential) error
	UpdateStatus(ctx context.Context, id string, status CredentialStatus) error
}

// PolicyRepository manages event attendance policies.
type PolicyRepository interface {
	FindByEventID(ctx context.Context, eventID string) (*AttendancePolicy, error)
	Upsert(ctx context.Context, policy *AttendancePolicy) error
}

// ScanEventRepository records and queries scan events.
type ScanEventRepository interface {
	Create(ctx context.Context, event *ScanEvent) error
	SummarizeByEventID(ctx context.Context, eventID string) (*AttendanceSummary, error)
}
