package service

import (
	"context"
	"fmt"

	"github.com/acme/venue-service/internal/repository"
	"go.uber.org/zap"
)

// VenueService provides business logic for the venue-service.
// CP-07 covers only Kafka event handling (release/finalize seated reservations).
// Full seat hold and reservation logic arrives in CP-09/CP-10.
type VenueService struct {
	reservationRepo repository.ReservationRepository
	sectionRepo     repository.SectionRepository
	log             *zap.Logger
}

// NewVenueService creates a new VenueService.
func NewVenueService(
	reservationRepo repository.ReservationRepository,
	sectionRepo repository.SectionRepository,
	log *zap.Logger,
) *VenueService {
	return &VenueService{
		reservationRepo: reservationRepo,
		sectionRepo:     sectionRepo,
		log:             log,
	}
}

// OnOrderCancelled handles the orders.order.cancelled Kafka event.
// Releases the seated reservation and restores seats to AVAILABLE.
// Idempotent: already-released reservations return success.
func (s *VenueService) OnOrderCancelled(ctx context.Context, reservationID string) error {
	if err := s.reservationRepo.ReleaseReservation(ctx, reservationID, "CANCELLED"); err != nil {
		if err == repository.ErrReservationAlreadyDone {
			s.log.Info("OnOrderCancelled: reservation already released (idempotent)",
				zap.String("reservationId", reservationID),
			)
			return nil
		}
		if err == repository.ErrReservationNotFound {
			// No seated reservation for this order — GA-only order, skip.
			s.log.Debug("OnOrderCancelled: no seated reservation found, skipping",
				zap.String("reservationId", reservationID),
			)
			return nil
		}
		return fmt.Errorf("release reservation %s: %w", reservationID, err)
	}

	s.log.Info("OnOrderCancelled: seated reservation released",
		zap.String("reservationId", reservationID),
	)
	return nil
}

// OnOrderCompleted handles the orders.order.completed Kafka event.
// Finalizes the seated reservation — transitions RESERVED → SOLD.
// Idempotent: already-sold reservations return success.
func (s *VenueService) OnOrderCompleted(ctx context.Context, reservationID, orderID string) error {
	if err := s.reservationRepo.FinalizeReservation(ctx, reservationID, orderID); err != nil {
		if err == repository.ErrReservationAlreadyDone {
			s.log.Info("OnOrderCompleted: reservation already finalized (idempotent)",
				zap.String("reservationId", reservationID),
				zap.String("orderId", orderID),
			)
			return nil
		}
		if err == repository.ErrReservationNotFound {
			s.log.Debug("OnOrderCompleted: no seated reservation found, skipping",
				zap.String("reservationId", reservationID),
			)
			return nil
		}
		return fmt.Errorf("finalize reservation %s: %w", reservationID, err)
	}

	s.log.Info("OnOrderCompleted: seated reservation finalized",
		zap.String("reservationId", reservationID),
		zap.String("orderId", orderID),
	)
	return nil
}
