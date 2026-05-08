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
	"strings"
	"time"

	"github.com/acme/attendance-service/internal/kafka"
	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
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
	qrGen    *qr.Generator
	tokenTTL time.Duration
	log      *zap.Logger
}

// NewIssuanceService creates an IssuanceService.
// tokenTTL controls how far in the future the QR token ExpiresAt is set;
// use 0 to apply the default (1 year).
func NewIssuanceService(
	credRepo repository.CredentialRepository,
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
		qrGen:    qrGen,
		tokenTTL: ttl,
		log:      log,
	}
}

// OnOrderCompleted implements kafka.OrderEventHandler.
func (s *IssuanceService) OnOrderCompleted(ctx context.Context, data kafka.OrderCompletedData) error {
	start := time.Now()
	ctx, span := otel.Tracer("attendance-service.issuance").Start(ctx, "attendance.issuance.order_completed")
	defer func() {
		observeIssuance(len(admissionUnits(data)), time.Since(start).Seconds())
		span.End()
	}()

	if data.OrderID == "" || data.TicketID == "" {
		return fmt.Errorf("issuance: malformed event: orderId and ticketId are required (orderID=%q ticketID=%q)",
			data.OrderID, data.TicketID)
	}
	if strings.TrimSpace(data.UserID) == "" {
		return fmt.Errorf("issuance: malformed event: userId is required (orderID=%q ticketID=%q)",
			data.OrderID, data.TicketID)
	}
	normalizedSeatIDs := make([]string, len(data.SeatIDs))
	for i, seatID := range data.SeatIDs {
		normalizedSeatID := strings.TrimSpace(seatID)
		if normalizedSeatID == "" {
			return fmt.Errorf("issuance: malformed event: seated orders require non-blank seatIds (orderID=%q ticketID=%q)",
				data.OrderID, data.TicketID)
		}
		normalizedSeatIDs[i] = normalizedSeatID
	}
	if len(normalizedSeatIDs) > 1 {
		seen := make(map[string]struct{}, len(normalizedSeatIDs))
		for _, seatID := range normalizedSeatIDs {
			if _, ok := seen[seatID]; ok {
				return fmt.Errorf("issuance: malformed event: duplicate seatIds (orderID=%q ticketID=%q seatID=%q)",
					data.OrderID, data.TicketID, seatID)
			}
			seen[seatID] = struct{}{}
		}
	}
	if len(data.SeatIDs) == 0 && data.Quantity < 1 {
		return fmt.Errorf("issuance: malformed event: GA orders require quantity >= 1 when seatIds are empty (orderID=%q ticketID=%q quantity=%d)",
			data.OrderID, data.TicketID, data.Quantity)
	}

	// eventId derivation: see struct-level NOTE above.
	eventID := data.TicketID

	data.SeatIDs = normalizedSeatIDs
	units := admissionUnits(data)
	span.SetAttributes(
		attribute.String("attendance.order_id", data.OrderID),
		attribute.String("attendance.ticket_id", data.TicketID),
		attribute.String("attendance.event_id", eventID),
		attribute.Int("attendance.units", len(units)),
	)
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
// GA orders produce one unit per Quantity; non-positive quantities yield no units.
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
		return nil
	}
	units := make([]admissionUnit, qty)
	for i := range units {
		units[i] = admissionUnit{
			issuanceKey: data.OrderID + ":unit:" + strconv.Itoa(i),
		}
	}
	return units
}

// issueOne issues a single credential for one admission unit.
//
// State machine:
//   - credential not found             → create + durable outbox row in one transaction
//   - credential exists, not published → leave relay responsibility to the outbox path
//   - credential exists, published     → skip (idempotent duplicate)
func (s *IssuanceService) issueOne(
	ctx context.Context,
	data kafka.OrderCompletedData,
	eventID string,
	unit admissionUnit,
) error {
	// Check for existing credential.
	existing, err := s.credRepo.FindByIssuanceKey(ctx, unit.issuanceKey)
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		return fmt.Errorf("check existing credential: %w", err)
	}

	if existing != nil {
		return s.logDuplicateCredential(unit.issuanceKey, existing)
	}

	credentialID := uuid.New().String()
	tokenID := uuid.New().String()
	now := time.Now().UTC()

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

	cred := &repository.AdmissionCredential{
		ID:           credentialID,
		TicketID:     data.TicketID,
		OrderID:      data.OrderID,
		BuyerUserID:  &data.UserID,
		EventID:      eventID,
		TokenVersion: 1,
		TokenID:      tokenID,
		QRToken:      &token,
		IssuanceKey:  unit.issuanceKey,
		Status:       repository.CredentialStatusIssued,
		IssuedAt:     now,
	}
	payload, err := buildIssuanceEventPayload(cred, token)
	if err != nil {
		return fmt.Errorf("build issuance event payload: %w", err)
	}
	outbox := &repository.OutboxRow{
		ID:           credentialID,
		Topic:        kafka.TopicAttendanceQRIssued,
		Payload:      payload,
		TraceHeaders: json.RawMessage(`{}`),
		PartitionKey: credentialID,
	}
	if err := s.credRepo.CreateWithOutbox(ctx, cred, outbox); err != nil {
		if errors.Is(err, repository.ErrDuplicate) {
			existing, findErr := s.credRepo.FindByIssuanceKey(ctx, unit.issuanceKey)
			if findErr != nil {
				return fmt.Errorf("re-read existing credential after duplicate create: %w", findErr)
			}
			return s.logDuplicateCredential(unit.issuanceKey, existing)
		}
		return fmt.Errorf("store credential with outbox: %w", err)
	}

	s.log.Info("issuance: credential issued and queued for relay",
		zap.String("credentialId", credentialID),
		zap.String("orderId", data.OrderID),
		zap.String("ticketId", data.TicketID),
		zap.String("issuanceKey", unit.issuanceKey),
	)
	return nil
}

func (s *IssuanceService) logDuplicateCredential(issuanceKey string, existing *repository.AdmissionCredential) error {
	if existing == nil {
		return fmt.Errorf("duplicate credential lookup returned no row for issuance key %q", issuanceKey)
	}
	if existing.IssuanceEventPublishedAt != nil {
		s.log.Info("issuance: credential already published, skipping (idempotent duplicate)",
			zap.String("issuanceKey", issuanceKey),
			zap.String("credentialId", existing.ID),
		)
		return nil
	}
	s.log.Info("issuance: credential already queued in outbox, waiting for relay",
		zap.String("issuanceKey", issuanceKey),
		zap.String("credentialId", existing.ID),
	)
	return nil
}

func buildIssuanceEventPayload(cred *repository.AdmissionCredential, qrToken string) ([]byte, error) {
	eventData := QRIssuedEventData{
		CredentialID: cred.ID,
		TicketID:     cred.TicketID,
		EventID:      cred.EventID,
		OrderID:      cred.OrderID,
		IssuedAt:     cred.IssuedAt,
		QRToken:      qrToken,
	}
	dataBytes, err := json.Marshal(eventData)
	if err != nil {
		return nil, fmt.Errorf("marshal issuance event data: %w", err)
	}

	envelope := kafka.CloudEvent{
		SpecVersion:     "1.0",
		Type:            kafka.TopicAttendanceQRIssued,
		Source:          "attendance-service",
		ID:              cred.ID,
		Time:            cred.IssuedAt,
		DataContentType: "application/json",
		Data:            dataBytes,
	}
	envelopeBytes, err := json.Marshal(envelope)
	if err != nil {
		return nil, fmt.Errorf("marshal cloud event envelope: %w", err)
	}

	return envelopeBytes, nil
}
