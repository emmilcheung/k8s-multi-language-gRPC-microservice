package hold

import (
	"context"
	"sync"
	"time"

	"github.com/acme/venue-service/internal/repository"
)

// CachedSeatLimit keeps each ticket's limit for ttl so holds do not call
// ticket-service on every request. When a refresh fails, the last known limit
// is used: the limit rarely changes, so a ticket-service outage should not
// stop seat selection. Only a ticket never seen before fails the hold.
func CachedSeatLimit(f SeatLimitFunc, ttl time.Duration) SeatLimitFunc {
	type entry struct {
		limit   int
		fetched time.Time
	}
	var (
		mu    sync.Mutex
		cache = map[string]entry{}
	)
	return func(ctx context.Context, plan *repository.SeatingPlan) (int, error) {
		mu.Lock()
		e, ok := cache[plan.TicketID]
		mu.Unlock()
		if ok && time.Since(e.fetched) < ttl {
			return e.limit, nil
		}
		limit, err := f(ctx, plan)
		if err != nil {
			if ok {
				return e.limit, nil
			}
			return 0, err
		}
		mu.Lock()
		cache[plan.TicketID] = entry{limit: limit, fetched: time.Now()}
		mu.Unlock()
		return limit, nil
	}
}
