package repository

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/acme/ticket-service/internal/cache"
	"go.uber.org/zap"
	"golang.org/x/sync/singleflight"
)

type CachingTicketRepository struct {
	inner TicketRepository
	cache cache.TicketCache
	log   *zap.Logger
	// load coalesces concurrent cold-miss loads per pod (stateless — holds no
	// cached data, so no cross-pod incoherence). refreshing guards against
	// spawning more than one in-flight background SWR refresh per key per pod.
	load       singleflight.Group
	refreshing sync.Map // map[string]struct{} — keys with an in-flight refresh

	// loadTimeout bounds the detached shared load/refresh against a hung DB.
	loadTimeout time.Duration
}

// Cached values are JSON-encoded Ticket structs. Note: Ticket carries only bson
// tags, so json.Marshal uses Go field names ("ID", "Title", ...). Adding json
// tags to Ticket would change cache key shape and invalidate every entry on
// deploy — keep that in mind before tagging it.

func NewCachingTicketRepository(inner TicketRepository, ticketCache cache.TicketCache, log *zap.Logger) *CachingTicketRepository {
	return &CachingTicketRepository{
		inner:       inner,
		cache:       ticketCache,
		log:         log,
		loadTimeout: 10 * time.Second,
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
	swr, isSWR := r.cache.(cache.SWRTicketCache)

	// --- Read from cache (SWR-aware when supported) ---
	var data []byte
	var stale bool
	var err error
	if isSWR {
		data, stale, err = swr.GetTicketSWR(ctx, id)
	} else {
		data, err = r.cache.GetTicket(ctx, id)
	}
	if err != nil {
		r.log.Warn("failed to read ticket cache", zap.String("ticketId", id), zap.Error(err))
	}
	if data != nil {
		if isSWR && stale {
			r.triggerTicketRefresh(swr, id)
		}
		var cached Ticket
		if err := json.Unmarshal(data, &cached); err != nil {
			r.log.Warn("failed to decode cached ticket", zap.String("ticketId", id), zap.Error(err))
		} else {
			return &cached, nil
		}
	}

	// --- Cold miss: coalesce the DB load + cache populate per pod ---
	// The shared load detaches from the leader's request cancellation (keeping
	// trace values) so one caller disconnecting cannot fail every coalesced
	// waiter — which would re-create the stampede this cache exists to prevent.
	loaded, err, _ := r.load.Do("ticket:"+id, func() (interface{}, error) {
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), r.loadTimeout)
		defer cancel()
		ticket, err := r.inner.FindByID(loadCtx, id)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(ticket)
		if err != nil {
			return nil, err
		}
		if err := r.cache.SetTicket(loadCtx, id, encoded); err != nil {
			r.log.Warn("failed to write ticket cache", zap.String("ticketId", id), zap.Error(err))
		}
		return encoded, nil
	})
	if err != nil {
		return nil, err
	}
	var ticket Ticket
	if err := json.Unmarshal(loaded.([]byte), &ticket); err != nil {
		return nil, err
	}
	return &ticket, nil
}

// triggerTicketRefresh asynchronously rebuilds a stale ticket entry. The
// per-pod in-flight guard ensures at most one refresh goroutine per key on this
// pod (so a burst of stale reads doesn't spawn a goroutine each), and the Redis
// lock ensures only one pod fleet-wide actually rebuilds. The caller has already
// been served the stale value, so this never blocks the request. The refresh
// runs on a detached context so it outlives the triggering request.
func (r *CachingTicketRepository) triggerTicketRefresh(swr cache.SWRTicketCache, id string) {
	key := "ticket:" + id
	if _, inflight := r.refreshing.LoadOrStore(key, struct{}{}); inflight {
		return // a refresh for this key is already running on this pod
	}
	go func() {
		defer r.refreshing.Delete(key)
		ctx, cancel := context.WithTimeout(context.Background(), r.loadTimeout)
		defer cancel()
		acquired, err := swr.TryRefreshTicket(ctx, id)
		if err != nil || !acquired {
			return
		}
		ticket, err := r.inner.FindByID(ctx, id)
		if err != nil {
			r.log.Warn("swr refresh: db read failed", zap.String("ticketId", id), zap.Error(err))
			return
		}
		encoded, err := json.Marshal(ticket)
		if err != nil {
			return
		}
		if err := r.cache.SetTicket(ctx, id, encoded); err != nil {
			r.log.Warn("swr refresh: cache write failed", zap.String("ticketId", id), zap.Error(err))
		}
	}()
}

// FindByIDs delegates to the inner repository — caching individual tickets on
// the way through so subsequent single-ID lookups can hit cache.
func (r *CachingTicketRepository) FindByIDs(ctx context.Context, ids []string) ([]*Ticket, error) {
	return r.inner.FindByIDs(ctx, ids)
}

func (r *CachingTicketRepository) FindAll(ctx context.Context, p PaginationParams) ([]*Ticket, error) {
	useCache := p.After == "" && (p.Limit <= 0 || p.Limit == 20) && !p.AvailableOnly
	if !useCache {
		return r.inner.FindAll(ctx, p)
	}

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

	loaded, err, _ := r.load.Do("list", func() (interface{}, error) {
		// Detached from request cancellation (see FindByID) so a coalesced
		// waiter is not failed by the leader's disconnect.
		loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), r.loadTimeout)
		defer cancel()
		tickets, err := r.inner.FindAll(loadCtx, p)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(tickets)
		if err != nil {
			return nil, err
		}
		if err := r.cache.SetList(loadCtx, encoded); err != nil {
			r.log.Warn("failed to write tickets list cache", zap.Error(err))
		}
		return encoded, nil
	})
	if err != nil {
		return nil, err
	}
	var tickets []*Ticket
	if err := json.Unmarshal(loaded.([]byte), &tickets); err != nil {
		return nil, err
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
	// No cache invalidation: reservation changes counters, not displayed
	// metadata. Availability is served coarsely from the quota gate, and the
	// short SWR soft TTL bounds staleness. Invalidating here would keep a hot
	// ticket's cache key permanently cold during onsale.
	return r.inner.ReserveTicket(ctx, ticketID, orderID)
}

func (r *CachingTicketRepository) ReleaseTicket(ctx context.Context, ticketID string) error {
	return r.inner.ReleaseTicket(ctx, ticketID)
}

func (r *CachingTicketRepository) Ping(ctx context.Context) error {
	return r.inner.Ping(ctx)
}

func (r *CachingTicketRepository) Close(ctx context.Context) error {
	return r.inner.Close(ctx)
}

// ─── Quota-based reservation passthrough ─────────────────────────────────────

func (r *CachingTicketRepository) CreateReservation(ctx context.Context, res *TicketReservation) error {
	return r.inner.CreateReservation(ctx, res)
}

func (r *CachingTicketRepository) FindReservationByID(ctx context.Context, reservationID string) (*TicketReservation, error) {
	return r.inner.FindReservationByID(ctx, reservationID)
}

func (r *CachingTicketRepository) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	return r.inner.FinalizeReservation(ctx, reservationID, orderID)
}

func (r *CachingTicketRepository) ReleaseReservation(ctx context.Context, reservationID string) error {
	return r.inner.ReleaseReservation(ctx, reservationID)
}
