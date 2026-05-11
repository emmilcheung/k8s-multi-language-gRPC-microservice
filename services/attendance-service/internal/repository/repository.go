// Package repository defines data-access interfaces for attendance-service.
// Concrete implementations live in repository/postgres.
package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrNotFound is returned by repositories when a record does not exist.
var ErrNotFound = errors.New("repository: record not found")

// ErrDuplicate is returned when a repository insert conflicts with an existing
// record that already satisfies the requested uniqueness constraint.
var ErrDuplicate = errors.New("repository: duplicate record")

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
	ScanResultValidated    ScanResult = "VALIDATED"
)

// AdmissionCredential is the domain object for an issued admission credential.
type AdmissionCredential struct {
	ID           string
	TicketID     string
	OrderID      string
	BuyerUserID  *string
	EventID      string
	TokenVersion int
	TokenID      string
	QRToken      *string
	// IssuanceKey is the deterministic per-admission-unit key used for idempotent
	// duplicate detection.  See migration 002 for derivation rules.
	IssuanceKey string
	Status      CredentialStatus
	IssuedAt    time.Time
	// IssuanceEventPublishedAt is set to the time the attendance.qr.issued CloudEvent
	// was successfully published.  A nil value means the credential was persisted but
	// the event has not yet been published (e.g. publish failed on a prior attempt).
	// See migration 003 for the backfill strategy applied to pre-existing rows.
	IssuanceEventPublishedAt *time.Time
	RevokedAt                *time.Time
	UsedAt                   *time.Time
	UsedByUserID             *string
	UsedByDeviceID           *string
	CreatedAt                time.Time
	UpdatedAt                time.Time
}

// OutboxRow is a durable Kafka message waiting to be relayed.
type OutboxRow struct {
	ID           string
	Topic        string
	Payload      json.RawMessage
	TraceHeaders json.RawMessage
	PartitionKey string
	Published    bool
	CreatedAt    time.Time
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
	EventID        string
	TotalAdmitted  int
	TotalDenied    int
	TotalCheckedIn int
}

// CredentialRepository manages admission credentials.
type CredentialRepository interface {
	FindByID(ctx context.Context, id string) (*AdmissionCredential, error)
	FindByTicketID(ctx context.Context, ticketID string) (*AdmissionCredential, error)
	FindByTicketAndBuyer(ctx context.Context, ticketID, buyerUserID string) (*AdmissionCredential, error)
	FindByTicketAndOrder(ctx context.Context, ticketID, orderID string) (*AdmissionCredential, error)
	// FindByIssuanceKey returns the credential for the given idempotency key.
	// Returns ErrNotFound if no credential exists for the key.
	FindByIssuanceKey(ctx context.Context, issuanceKey string) (*AdmissionCredential, error)
	CreateWithOutbox(ctx context.Context, cred *AdmissionCredential, outbox *OutboxRow) error
	Create(ctx context.Context, cred *AdmissionCredential) error
	// ConsumeIssued marks an ISSUED credential as USED atomically.
	// Returns consumed=false with the current credential if status was not ISSUED.
	ConsumeIssued(
		ctx context.Context,
		id string,
		usedAt time.Time,
		scannerUserID, deviceID string,
	) (*AdmissionCredential, bool, error)
	UpdateStatus(ctx context.Context, id string, status CredentialStatus) error
	// MarkEventPublished records the time at which the attendance.qr.issued CloudEvent
	// was successfully published for the given credential.  It is called after a
	// successful Kafka publish so that retries can distinguish "not yet published"
	// from "already published".
	MarkEventPublished(ctx context.Context, id string, publishedAt time.Time) error
	// ListCheckedInByEventID returns recently checked-in credentials (status USED)
	// for an event, ordered by most recent check-in first.
	ListCheckedInByEventID(ctx context.Context, eventID string, limit int) ([]*AdmissionCredential, error)
}

// OutboxRepository manages unpublished outbox rows and publish acknowledgements.
type OutboxRepository interface {
	ListUnpublished(ctx context.Context, limit int) ([]*OutboxRow, error)
	MarkPublished(ctx context.Context, id string, publishedAt time.Time) error
	// ListUnpublishedTx selects up to limit unpublished outbox rows inside tx
	// using FOR UPDATE SKIP LOCKED so that concurrent relay replicas each claim
	// disjoint sets of rows.  The caller must commit or roll back tx.
	ListUnpublishedTx(ctx context.Context, tx pgx.Tx, limit int) ([]*OutboxRow, error)
	// MarkPublishedTx marks a single outbox row as published inside an existing
	// transaction.  The caller owns the commit/rollback lifecycle.
	MarkPublishedTx(ctx context.Context, tx pgx.Tx, id string, publishedAt time.Time) error
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
