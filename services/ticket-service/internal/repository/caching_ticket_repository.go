package repository

import (
	"context"
	"encoding/json"

	"github.com/acme/ticket-service/internal/cache"
	"go.uber.org/zap"
)

type CachingTicketRepository struct {
	inner TicketRepository
	cache cache.TicketCache
	log   *zap.Logger
}

func NewCachingTicketRepository(inner TicketRepository, ticketCache cache.TicketCache, log *zap.Logger) *CachingTicketRepository {
	return &CachingTicketRepository{
		inner: inner,
		cache: ticketCache,
		log:   log,
	}
}

func (r *CachingTicketRepository) Create(ctx context.Context, t *Ticket) error {
	if err := r.inner.Create(ctx, t); err != nil {
		return err
	}
	if err := r.cache.InvalidateList(ctx); err != nil {
		r.log.Warn("failed to invalidate ticket list cache", zap.Error(err))
	}
	return nil
}

func (r *CachingTicketRepository) FindByID(ctx context.Context, id string) (*Ticket, error) {
	if data, err := r.cache.GetTicket(ctx, id); err != nil {
		r.log.Warn("failed to read ticket cache", zap.String("ticketId", id), zap.Error(err))
	} else if data != nil {
		var cached Ticket
		if err := json.Unmarshal(data, &cached); err != nil {
			r.log.Warn("failed to decode cached ticket", zap.String("ticketId", id), zap.Error(err))
		} else {
			return &cached, nil
		}
	}

	ticket, err := r.inner.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if data, err := json.Marshal(ticket); err != nil {
		r.log.Warn("failed to encode ticket for cache", zap.String("ticketId", id), zap.Error(err))
	} else if err := r.cache.SetTicket(ctx, id, data); err != nil {
		r.log.Warn("failed to write ticket cache", zap.String("ticketId", id), zap.Error(err))
	}

	return ticket, nil
}

func (r *CachingTicketRepository) FindAll(ctx context.Context, p PaginationParams) ([]*Ticket, error) {
	// Cache is only used for the default first-page request (no cursor, default limit).
	// Paginated pages beyond the first are fetched directly from the DB.
	useCache := p.After == "" && (p.Limit <= 0 || p.Limit == 20)

	if useCache {
		if data, err := r.cache.GetList(ctx); err != nil {
			r.log.Warn("failed to read tickets list cache", zap.Error(err))
		} else if data != nil {
			var cached []*Ticket
			if err := json.Unmarshal(data, &cached); err != nil {
				r.log.Warn("failed to decode cached tickets list", zap.Error(err))
			} else {
				return cached, nil
			}
		}
	}

	tickets, err := r.inner.FindAll(ctx, p)
	if err != nil {
		return nil, err
	}

	if useCache {
		if data, err := json.Marshal(tickets); err != nil {
			r.log.Warn("failed to encode tickets list for cache", zap.Error(err))
		} else if err := r.cache.SetList(ctx, data); err != nil {
			r.log.Warn("failed to write tickets list cache", zap.Error(err))
		}
	}

	return tickets, nil
}

func (r *CachingTicketRepository) Update(ctx context.Context, t *Ticket) error {
	if err := r.inner.Update(ctx, t); err != nil {
		return err
	}
	if err := r.cache.InvalidateTicket(ctx, t.ID); err != nil {
		r.log.Warn("failed to invalidate ticket cache", zap.String("ticketId", t.ID), zap.Error(err))
	}
	if err := r.cache.InvalidateList(ctx); err != nil {
		r.log.Warn("failed to invalidate ticket list cache", zap.Error(err))
	}
	return nil
}

func (r *CachingTicketRepository) ReserveTicket(ctx context.Context, ticketID, orderID string) error {
	if err := r.inner.ReserveTicket(ctx, ticketID, orderID); err != nil {
		return err
	}
	if err := r.cache.InvalidateTicket(ctx, ticketID); err != nil {
		r.log.Warn("failed to invalidate ticket cache after reserve", zap.String("ticketId", ticketID), zap.Error(err))
	}
	if err := r.cache.InvalidateList(ctx); err != nil {
		r.log.Warn("failed to invalidate ticket list cache after reserve", zap.Error(err))
	}
	return nil
}

func (r *CachingTicketRepository) ReleaseTicket(ctx context.Context, ticketID string) error {
	if err := r.inner.ReleaseTicket(ctx, ticketID); err != nil {
		return err
	}
	if err := r.cache.InvalidateTicket(ctx, ticketID); err != nil {
		r.log.Warn("failed to invalidate ticket cache after release", zap.String("ticketId", ticketID), zap.Error(err))
	}
	if err := r.cache.InvalidateList(ctx); err != nil {
		r.log.Warn("failed to invalidate ticket list cache after release", zap.Error(err))
	}
	return nil
}

func (r *CachingTicketRepository) Ping(ctx context.Context) error {
	return r.inner.Ping(ctx)
}

func (r *CachingTicketRepository) Close(ctx context.Context) error {
	return r.inner.Close(ctx)
}

// ─── Quota-based reservation passthrough ─────────────────────────────────────
// Reservation writes invalidate the ticket cache because reserved/sold counters change.

func (r *CachingTicketRepository) CreateReservation(ctx context.Context, res *TicketReservation) error {
	if err := r.inner.CreateReservation(ctx, res); err != nil {
		return err
	}
	if err := r.cache.InvalidateTicket(ctx, res.TicketID); err != nil {
		r.log.Warn("failed to invalidate ticket cache after CreateReservation", zap.String("ticketId", res.TicketID), zap.Error(err))
	}
	if err := r.cache.InvalidateList(ctx); err != nil {
		r.log.Warn("failed to invalidate ticket list cache after CreateReservation", zap.Error(err))
	}
	return nil
}

func (r *CachingTicketRepository) FindReservationByID(ctx context.Context, reservationID string) (*TicketReservation, error) {
	return r.inner.FindReservationByID(ctx, reservationID)
}

func (r *CachingTicketRepository) ReleaseReservation(ctx context.Context, reservationID string) error {
	res, err := r.inner.FindReservationByID(ctx, reservationID)
	if err != nil {
		return err
	}
	if err := r.inner.ReleaseReservation(ctx, reservationID); err != nil {
		return err
	}
	if err := r.cache.InvalidateTicket(ctx, res.TicketID); err != nil {
		r.log.Warn("failed to invalidate ticket cache after ReleaseReservation", zap.String("ticketId", res.TicketID), zap.Error(err))
	}
	if err := r.cache.InvalidateList(ctx); err != nil {
		r.log.Warn("failed to invalidate ticket list cache after ReleaseReservation", zap.Error(err))
	}
	return nil
}

func (r *CachingTicketRepository) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	res, err := r.inner.FindReservationByID(ctx, reservationID)
	if err != nil {
		return err
	}
	if err := r.inner.FinalizeReservation(ctx, reservationID, orderID); err != nil {
		return err
	}
	if err := r.cache.InvalidateTicket(ctx, res.TicketID); err != nil {
		r.log.Warn("failed to invalidate ticket cache after FinalizeReservation", zap.String("ticketId", res.TicketID), zap.Error(err))
	}
	if err := r.cache.InvalidateList(ctx); err != nil {
		r.log.Warn("failed to invalidate ticket list cache after FinalizeReservation", zap.Error(err))
	}
	return nil
}
