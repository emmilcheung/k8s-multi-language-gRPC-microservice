package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/acme/attendance-service/internal/qr"
	"github.com/acme/attendance-service/internal/repository"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
)

type ScanResultClass string

const (
	ScanResultValid            ScanResultClass = "valid"
	ScanResultAlreadyUsed      ScanResultClass = "already_used"
	ScanResultRevoked          ScanResultClass = "revoked"
	ScanResultInvalidSignature ScanResultClass = "invalid_signature"
	ScanResultWrongEvent       ScanResultClass = "wrong_event"
	ScanResultNotFound         ScanResultClass = "not_found"
	ScanResultPolicyBlock      ScanResultClass = "policy_block"
)

type ScanOutcome struct {
	Result       ScanResultClass
	CredentialID string
	EventID      string
	Status       repository.CredentialStatus
}

type ScanService interface {
	Validate(ctx context.Context, token, eventID, scannerUserID, deviceID string, gateID *string) (*ScanOutcome, error)
	CheckIn(ctx context.Context, token, eventID, scannerUserID, deviceID string, gateID *string) (*ScanOutcome, error)
	// CheckInByBuyer checks in an attendee by buyer user ID (manual fallback).
	// policy is the event's attendance policy; nil means no row exists and defaults to blocked.
	// Returns ErrPolicyBlock when allow_manual_override is false or policy is nil.
	CheckInByBuyer(ctx context.Context, eventID, buyerUserID, scannerUserID, deviceID string, gateID *string, policy *repository.AttendancePolicy) (*ScanOutcome, error)
}

type scanService struct {
	credRepo repository.CredentialRepository
	scanRepo repository.ScanEventRepository
	qrGen    *qr.Generator
	log      *zap.Logger
	tracer   trace.Tracer
}

func NewScanService(
	credRepo repository.CredentialRepository,
	scanRepo repository.ScanEventRepository,
	qrGen *qr.Generator,
	log *zap.Logger,
) ScanService {
	return &scanService{
		credRepo: credRepo,
		scanRepo: scanRepo,
		qrGen:    qrGen,
		log:      log,
		tracer:   otel.Tracer("attendance-service.scan"),
	}
}

func (s *scanService) Validate(
	ctx context.Context,
	token, eventID, scannerUserID, deviceID string,
	gateID *string,
) (*ScanOutcome, error) {
	ctx, span := s.tracer.Start(ctx, "attendance.scan.validate")
	defer span.End()
	return s.evaluate(ctx, token, eventID, scannerUserID, deviceID, gateID, false)
}

func (s *scanService) CheckIn(
	ctx context.Context,
	token, eventID, scannerUserID, deviceID string,
	gateID *string,
) (*ScanOutcome, error) {
	ctx, span := s.tracer.Start(ctx, "attendance.scan.checkin")
	defer span.End()
	return s.evaluate(ctx, token, eventID, scannerUserID, deviceID, gateID, true)
}

func (s *scanService) CheckInByBuyer(
	ctx context.Context,
	eventID, buyerUserID, scannerUserID, deviceID string,
	gateID *string,
	policy *repository.AttendancePolicy,
) (*ScanOutcome, error) {
	ctx, span := s.tracer.Start(ctx, "attendance.scan.checkin_by_buyer")
	defer span.End()
	traceID := trace.SpanContextFromContext(ctx).TraceID().String()

	// Enforce event attendance policy before doing any ticket lookup.
	// Default when no policy row exists: allow_manual_override = false → blocked.
	if policy == nil || !policy.AllowManualOverride {
		_ = s.recordManualScan(ctx, "", eventID, scannerUserID, deviceID, gateID, repository.ScanResultPolicyBlock)
		s.log.Info("attendance scan result",
			zap.String("result", string(ScanResultPolicyBlock)),
			zap.String("reason", "policy_block"),
			zap.String("eventId", eventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return &ScanOutcome{Result: ScanResultPolicyBlock, EventID: eventID}, ErrPolicyBlock
	}

	cred, err := s.credRepo.FindByTicketAndBuyer(ctx, eventID, buyerUserID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			outcome := &ScanOutcome{
				Result:  ScanResultNotFound,
				EventID: eventID,
			}
			observeScanByMode(true, outcome.Result)
			_ = s.recordManualScan(ctx, "", eventID, scannerUserID, deviceID, gateID, repository.ScanResultInvalidToken)
			s.log.Info("attendance scan result",
				zap.String("result", string(outcome.Result)),
				zap.String("eventId", eventID),
				zap.String("scannerUserId", scannerUserID),
				zap.String("deviceId", deviceID),
				zap.String("traceId", traceID),
			)
			return outcome, nil
		}
		return nil, fmt.Errorf("scan: find credential by buyer: %w", err)
	}

	switch cred.Status {
	case repository.CredentialStatusRevoked, repository.CredentialStatusExpired:
		outcome := &ScanOutcome{
			Result:       ScanResultRevoked,
			CredentialID: cred.ID,
			EventID:      cred.EventID,
			Status:       cred.Status,
		}
		observeScanByMode(true, outcome.Result)
		_ = s.recordManualScan(ctx, cred.ID, cred.EventID, scannerUserID, deviceID, gateID, repository.ScanResultDenied)
		return outcome, nil
	case repository.CredentialStatusUsed:
		outcome := &ScanOutcome{
			Result:       ScanResultAlreadyUsed,
			CredentialID: cred.ID,
			EventID:      cred.EventID,
			Status:       cred.Status,
		}
		observeScanByMode(true, outcome.Result)
		_ = s.recordManualScan(ctx, cred.ID, cred.EventID, scannerUserID, deviceID, gateID, repository.ScanResultAlreadyUsed)
		return outcome, nil
	}

	consumedCred, consumed, err := s.credRepo.ConsumeIssued(ctx, cred.ID, time.Now().UTC(), scannerUserID, deviceID)
	if err != nil {
		return nil, fmt.Errorf("scan: consume credential by buyer: %w", err)
	}
	if consumed {
		outcome := &ScanOutcome{
			Result:       ScanResultValid,
			CredentialID: consumedCred.ID,
			EventID:      consumedCred.EventID,
			Status:       consumedCred.Status,
		}
		observeScanByMode(true, outcome.Result)
		_ = s.recordManualScan(ctx, consumedCred.ID, consumedCred.EventID, scannerUserID, deviceID, gateID, repository.ScanResultAdmitted)
		return outcome, nil
	}

	outcome := &ScanOutcome{
		Result:       ScanResultAlreadyUsed,
		CredentialID: consumedCred.ID,
		EventID:      consumedCred.EventID,
		Status:       consumedCred.Status,
	}
	observeScanByMode(true, outcome.Result)
	_ = s.recordManualScan(ctx, consumedCred.ID, consumedCred.EventID, scannerUserID, deviceID, gateID, repository.ScanResultAlreadyUsed)
	return outcome, nil
}

func (s *scanService) evaluate(
	ctx context.Context,
	token, eventID, scannerUserID, deviceID string,
	gateID *string,
	consume bool,
) (*ScanOutcome, error) {
	traceID := trace.SpanContextFromContext(ctx).TraceID().String()
	claims, err := s.qrGen.Verify(token)
	if err != nil {
		outcome := &ScanOutcome{Result: ScanResultInvalidSignature}
		observeScanByMode(consume, outcome.Result)
		_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultInvalidToken)
		s.log.Info("attendance scan result",
			zap.String("result", string(outcome.Result)),
			zap.String("eventId", eventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return outcome, nil
	}

	if eventID != "" && claims.EventID != eventID {
		outcome := &ScanOutcome{
			Result:       ScanResultWrongEvent,
			CredentialID: claims.CredentialID,
			EventID:      claims.EventID,
		}
		observeScanByMode(consume, outcome.Result)
		_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultDenied)
		s.log.Info("attendance scan result",
			zap.String("result", string(outcome.Result)),
			zap.String("credentialId", outcome.CredentialID),
			zap.String("eventId", outcome.EventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return outcome, nil
	}

	cred, err := s.credRepo.FindByID(ctx, claims.CredentialID)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			outcome := &ScanOutcome{
				Result:       ScanResultNotFound,
				CredentialID: claims.CredentialID,
				EventID:      claims.EventID,
			}
			observeScanByMode(consume, outcome.Result)
			_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultInvalidToken)
			s.log.Info("attendance scan result",
				zap.String("result", string(outcome.Result)),
				zap.String("credentialId", outcome.CredentialID),
				zap.String("eventId", outcome.EventID),
				zap.String("scannerUserId", scannerUserID),
				zap.String("deviceId", deviceID),
				zap.String("traceId", traceID),
			)
			return outcome, nil
		}
		return nil, fmt.Errorf("scan: find credential: %w", err)
	}

	if cred.TokenVersion != claims.TokenVersion {
		outcome := &ScanOutcome{
			Result:       ScanResultInvalidSignature,
			CredentialID: cred.ID,
			EventID:      cred.EventID,
			Status:       cred.Status,
		}
		observeScanByMode(consume, outcome.Result)
		_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultInvalidToken)
		s.log.Info("attendance scan result",
			zap.String("result", string(outcome.Result)),
			zap.String("credentialId", outcome.CredentialID),
			zap.String("eventId", outcome.EventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return outcome, nil
	}

	switch cred.Status {
	case repository.CredentialStatusRevoked, repository.CredentialStatusExpired:
		outcome := &ScanOutcome{
			Result:       ScanResultRevoked,
			CredentialID: cred.ID,
			EventID:      cred.EventID,
			Status:       cred.Status,
		}
		observeScanByMode(consume, outcome.Result)
		_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultDenied)
		s.log.Info("attendance scan result",
			zap.String("result", string(outcome.Result)),
			zap.String("credentialId", outcome.CredentialID),
			zap.String("eventId", outcome.EventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return outcome, nil
	case repository.CredentialStatusUsed:
		outcome := &ScanOutcome{
			Result:       ScanResultAlreadyUsed,
			CredentialID: cred.ID,
			EventID:      cred.EventID,
			Status:       cred.Status,
		}
		observeScanByMode(consume, outcome.Result)
		_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultAlreadyUsed)
		s.log.Info("attendance scan result",
			zap.String("result", string(outcome.Result)),
			zap.String("credentialId", outcome.CredentialID),
			zap.String("eventId", outcome.EventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return outcome, nil
	}

	// validate mode: do not consume credential.
	if !consume {
		outcome := &ScanOutcome{
			Result:       ScanResultValid,
			CredentialID: cred.ID,
			EventID:      cred.EventID,
			Status:       cred.Status,
		}
		observeScanByMode(consume, outcome.Result)
		_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultValidated)
		s.log.Info("attendance scan result",
			zap.String("result", string(outcome.Result)),
			zap.String("credentialId", outcome.CredentialID),
			zap.String("eventId", outcome.EventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return outcome, nil
	}

	consumedCred, consumed, err := s.credRepo.ConsumeIssued(ctx, cred.ID, time.Now().UTC(), scannerUserID, deviceID)
	if err != nil {
		return nil, fmt.Errorf("scan: consume credential: %w", err)
	}
	if consumed {
		outcome := &ScanOutcome{
			Result:       ScanResultValid,
			CredentialID: consumedCred.ID,
			EventID:      consumedCred.EventID,
			Status:       consumedCred.Status,
		}
		observeScanByMode(consume, outcome.Result)
		_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultAdmitted)
		s.log.Info("attendance scan result",
			zap.String("result", string(outcome.Result)),
			zap.String("credentialId", outcome.CredentialID),
			zap.String("eventId", outcome.EventID),
			zap.String("scannerUserId", scannerUserID),
			zap.String("deviceId", deviceID),
			zap.String("traceId", traceID),
		)
		return outcome, nil
	}

	// Another request likely consumed first.
	outcome := &ScanOutcome{
		Result:       ScanResultAlreadyUsed,
		CredentialID: consumedCred.ID,
		EventID:      consumedCred.EventID,
		Status:       consumedCred.Status,
	}
	observeScanByMode(consume, outcome.Result)
	_ = s.recordScan(ctx, claims, scannerUserID, deviceID, gateID, token, repository.ScanResultAlreadyUsed)
	s.log.Info("attendance scan result",
		zap.String("result", string(outcome.Result)),
		zap.String("credentialId", outcome.CredentialID),
		zap.String("eventId", outcome.EventID),
		zap.String("scannerUserId", scannerUserID),
		zap.String("deviceId", deviceID),
		zap.String("traceId", traceID),
	)
	return outcome, nil
}

func (s *scanService) recordScan(
	ctx context.Context,
	claims *qr.Claims,
	scannerUserID, deviceID string,
	gateID *string,
	rawToken string,
	result repository.ScanResult,
) error {
	_, span := s.tracer.Start(ctx, "attendance.scan.audit")
	defer span.End()
	hash := sha256.Sum256([]byte(rawToken))
	rawHash := hex.EncodeToString(hash[:])

	eventID := ""
	var credentialID *string
	if claims != nil {
		eventID = claims.EventID
		if claims.CredentialID != "" {
			id := claims.CredentialID
			credentialID = &id
		}
	}
	if eventID == "" {
		eventID = uuid.Nil.String()
	}

	scan := &repository.ScanEvent{
		ID:            uuid.New().String(),
		CredentialID:  credentialID,
		EventID:       eventID,
		ScannerUserID: scannerUserID,
		DeviceID:      deviceID,
		GateID:        gateID,
		Mode:          repository.ScanModeQR,
		Result:        result,
		RawTokenHash:  &rawHash,
		ScannedAt:     time.Now().UTC(),
	}
	span.SetAttributes(
		attribute.String("attendance.scan.result", string(result)),
		attribute.String("attendance.scan.event_id", scan.EventID),
		attribute.String("attendance.scan.scanner_user_id", scan.ScannerUserID),
		attribute.String("attendance.scan.device_id", scan.DeviceID),
	)
	return s.scanRepo.Create(ctx, scan)
}

func (s *scanService) recordManualScan(
	ctx context.Context,
	credentialID, eventID string,
	scannerUserID, deviceID string,
	gateID *string,
	result repository.ScanResult,
) error {
	_, span := s.tracer.Start(ctx, "attendance.scan.audit_manual")
	defer span.End()

	if eventID == "" {
		eventID = uuid.Nil.String()
	}
	var credentialIDPtr *string
	if credentialID != "" {
		credentialIDPtr = &credentialID
	}
	scan := &repository.ScanEvent{
		ID:            uuid.New().String(),
		CredentialID:  credentialIDPtr,
		EventID:       eventID,
		ScannerUserID: scannerUserID,
		DeviceID:      deviceID,
		GateID:        gateID,
		Mode:          repository.ScanModeManual,
		Result:        result,
		ScannedAt:     time.Now().UTC(),
	}
	span.SetAttributes(
		attribute.String("attendance.scan.result", string(result)),
		attribute.String("attendance.scan.event_id", scan.EventID),
		attribute.String("attendance.scan.scanner_user_id", scan.ScannerUserID),
		attribute.String("attendance.scan.device_id", scan.DeviceID),
	)
	return s.scanRepo.Create(ctx, scan)
}

func observeScanByMode(consume bool, result ScanResultClass) {
	if consume {
		observeScanCheckIn(result)
		return
	}
	observeScanValidation(result)
}
