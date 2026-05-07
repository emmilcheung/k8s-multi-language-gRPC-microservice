// Package service defines the attendance service business logic.
// IssuanceService implements kafka.OrderEventHandler and issues admission credentials
// for each completed order, publishing attendance.qr.issued CloudEvents.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/acme/attendance-service/internal/kafka"
	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// EventPublisher is the outbound Kafka publishing boundary used by IssuanceService.
// The concrete implementation is *kafka.Producer, kept as an interface for testability.
type EventPublisher interface {
	Publish(topic string, key, value []byte) error
}

// QRIssuedEventData is the data payload for the attendance.qr.issued CloudEvent.
// PII (userId) is deliberately excluded.  The signed qrToken carries only credential
// metadata so downstream delivery services can render the QR code without accessing
// personal data.
type QRIssuedEventData struct {
	CredentialID string    `json:"credentialId"`
	TicketID     string    `json:"ticketId"`
	EventID      string    `json:"eventId"`
	OrderID      string    `json:"orderId"`
	IssuedAt     time.Time `json:"issuedAt"`
	// QRToken is the signed credential token for QR code rendering.
	// It carries no PII; see qr.Claims for the embedded fields.
	QRToken string `json:"qrToken"`
}

// IssuanceService implements kafka.OrderEventHandler.
// On each orders.order.completed event it issues one admission credential per
// admission unit (GA: one per quantity unit; seated: one per seatId), stores the
// credential metadata in Postgres, and publishes an attendance.qr.issued CloudEvent.
//
// Idempotency is enforced via the issuance_key unique constraint:
//   - GA order:     "{orderId}:unit:{index}" (index = 0..quantity-1)
//   - Seated order: "{orderId}:seat:{seatId}"
//
// NOTE: eventId is derived as ticketId because the current orders.order.completed
// contract does not carry a first-class event ID and the ticket model stores
// denormalised event metadata without a distinct event identifier.  WS3 MUST use
// the same derivation (eventId := ticketId) unless an additive contract change
// introduces a true event ID field.
//
// Policy enforcement (require_qr_for_entry, allow_manual_override) is intentionally
// NOT applied at issuance time.  Credentials are issued for all completed admission
// orders unconditionally so the buyer-pass retrieval path works for WS3 before the
// organizer policy UI exists.  Policy enforcement lives in the scanner/check-in flow.
type IssuanceService struct {
	credRepo repository.CredentialRepository
	pub      EventPublisher
	qrGen    *qr.Generator
	tokenTTL time.Duration
	log      *zap.Logger
}

// NewIssuanceService creates an IssuanceService.
// tokenTTL controls how far in the future the QR token ExpiresAt is set;
// use 0 to apply the default (1 year).
func NewIssuanceService(
	credRepo repository.CredentialRepository,
	pub EventPublisher,
	qrGen *qr.Generator,
	tokenTTL time.Duration,
	log *zap.Logger,
) *IssuanceService {
	ttl := tokenTTL
	if ttl <= 0 {
		ttl = 365 * 24 * time.Hour
	}
	return &IssuanceService{
		credRepo: credRepo,
		pub:      pub,
		qrGen:    qrGen,
		tokenTTL: ttl,
		log:      log,
	}
}

// OnOrderCompleted implements kafka.OrderEventHandler.
func (s *IssuanceService) OnOrderCompleted(ctx context.Context, data kafka.OrderCompletedData) error {
	if data.OrderID == "" || data.TicketID == "" {
		return fmt.Errorf("issuance: malformed event: orderId and ticketId are required (orderID=%q ticketID=%q)",
			data.OrderID, data.TicketID)
	}

	// eventId derivation: see struct-level NOTE above.
	eventID := data.TicketID

	units := admissionUnits(data)
	for _, unit := range units {
		if err := s.issueOne(ctx, data, eventID, unit); err != nil {
			return fmt.Errorf("issuance: issue unit %q for order %q: %w",
				unit.issuanceKey, data.OrderID, err)
		}
	}
	return nil
}

// admissionUnit represents a single admission slot to be credentialed.
type admissionUnit struct {
	// issuanceKey is the deterministic dedup key for this unit.
	issuanceKey string
}

// admissionUnits returns the set of admission slots for the given order event.
// Seated orders (SeatIDs non-empty) produce one unit per seat.
// GA orders produce one unit per Quantity (minimum 1).
func admissionUnits(data kafka.OrderCompletedData) []admissionUnit {
	if len(data.SeatIDs) > 0 {
		units := make([]admissionUnit, len(data.SeatIDs))
		for i, seatID := range data.SeatIDs {
			units[i] = admissionUnit{
				issuanceKey: data.OrderID + ":seat:" + seatID,
			}
		}
		return units
	}

	qty := data.Quantity
	if qty < 1 {
		qty = 1
	}
	units := make([]admissionUnit, qty)
	for i := range units {
		units[i] = admissionUnit{
			issuanceKey: data.OrderID + ":unit:" + strconv.Itoa(i),
		}
	}
	return units
}

// issueOne issues a single credential for one admission unit.  It is idempotent:
// if a credential with the same issuance_key already exists it logs and returns nil.
func (s *IssuanceService) issueOne(
	ctx context.Context,
	data kafka.OrderCompletedData,
	eventID string,
	unit admissionUnit,
) error {
	// Check for existing credential (pre-insert idempotency check for clean log output).
	existing, err := s.credRepo.FindByIssuanceKey(ctx, unit.issuanceKey)
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		return fmt.Errorf("check existing credential: %w", err)
	}
	if existing != nil {
		s.log.Info("issuance: credential already exists for issuance key, skipping (idempotent)",
			zap.String("issuanceKey", unit.issuanceKey),
			zap.String("credentialId", existing.ID),
		)
		return nil
	}

	// Generate high-entropy, non-guessable credential and token IDs.
	credentialID := uuid.New().String()
	tokenID := uuid.New().String()
	now := time.Now().UTC()

	// Sign QR token. The token carries only credential metadata (no PII).
	claims := qr.Claims{
		V:            1,
		CredentialID: credentialID,
		TicketID:     data.TicketID,
		EventID:      eventID,
		TokenVersion: 1,
		IssuedAt:     now,
		ExpiresAt:    now.Add(s.tokenTTL),
	}
	token, err := s.qrGen.Generate(claims)
	if err != nil {
		return fmt.Errorf("generate qr token: %w", err)
	}

	// Persist credential metadata.  The token string itself is NOT stored;
	// only the token_id UUID is kept for audit / revocation lookups.
	cred := &repository.AdmissionCredential{
		ID:           credentialID,
		TicketID:     data.TicketID,
		OrderID:      data.OrderID,
		EventID:      eventID,
		TokenVersion: 1,
		TokenID:      tokenID,
		IssuanceKey:  unit.issuanceKey,
		Status:       repository.CredentialStatusIssued,
		IssuedAt:     now,
	}
	if err := s.credRepo.Create(ctx, cred); err != nil {
		return fmt.Errorf("store credential: %w", err)
	}

	// Publish attendance.qr.issued CloudEvent.
	// A publish failure is logged but does NOT roll back the credential record —
	// the credential is persisted and the event can be re-emitted by a replay job.
	if pubErr := s.publishIssuanceEvent(credentialID, data.TicketID, eventID, data.OrderID, now, token); pubErr != nil {
		s.log.Error("issuance: failed to publish attendance.qr.issued event (credential persisted)",
			zap.String("credentialId", credentialID),
			zap.Error(pubErr),
		)
	}

	s.log.Info("issuance: credential issued",
		zap.String("credentialId", credentialID),
		zap.String("orderId", data.OrderID),
		zap.String("ticketId", data.TicketID),
		zap.String("issuanceKey", unit.issuanceKey),
	)
	return nil
}

// publishIssuanceEvent builds and emits a CloudEvent for attendance.qr.issued.
// The partition key is the credentialId for deterministic per-credential routing.
func (s *IssuanceService) publishIssuanceEvent(
	credentialID, ticketID, eventID, orderID string,
	issuedAt time.Time,
	qrToken string,
) error {
	eventData := QRIssuedEventData{
		CredentialID: credentialID,
		TicketID:     ticketID,
		EventID:      eventID,
		OrderID:      orderID,
		IssuedAt:     issuedAt,
		QRToken:      qrToken,
	}
	dataBytes, err := json.Marshal(eventData)
	if err != nil {
		return fmt.Errorf("marshal issuance event data: %w", err)
	}

	envelope := kafka.CloudEvent{
		SpecVersion:     "1.0",
		Type:            kafka.TopicAttendanceQRIssued,
		Source:          "attendance-service",
		ID:              uuid.New().String(),
		Time:            issuedAt,
		DataContentType: "application/json",
		Data:            dataBytes,
	}
	envelopeBytes, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal cloud event envelope: %w", err)
	}

	return s.pub.Publish(kafka.TopicAttendanceQRIssued, []byte(credentialID), envelopeBytes)
}
