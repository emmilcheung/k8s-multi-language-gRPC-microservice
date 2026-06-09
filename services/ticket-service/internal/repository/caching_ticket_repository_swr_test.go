package repository

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// swrSpyCache implements cache.SWRTicketCache for tests. It serves a preset
// value with a controllable stale flag and records refresh-lock acquisitions
// and Set calls.
type swrSpyCache struct {
	mu         sync.Mutex
	ticketData []byte
	stale      bool
	sets       int32
	refreshes  int32
	lockHeld   bool
}

func (s *swrSpyCache) GetTicket(ctx context.Context, id string) ([]byte, error) {
	d, _, err := s.GetTicketSWR(ctx, id)
	return d, err
}
func (s *swrSpyCache) SetTicket(_ context.Context, _ string, data []byte) error {
	atomic.AddInt32(&s.sets, 1)
	s.mu.Lock()
	s.ticketData = data
	s.stale = false
	s.mu.Unlock()
	return nil
}
func (s *swrSpyCache) GetList(ctx context.Context) ([]byte, error)        { return nil, nil }
func (s *swrSpyCache) SetList(_ context.Context, _ []byte) error          { return nil }
func (s *swrSpyCache) InvalidateTicket(_ context.Context, _ string) error { return nil }
func (s *swrSpyCache) InvalidateList(_ context.Context) error             { return nil }
func (s *swrSpyCache) GetTicketSWR(_ context.Context, _ string) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ticketData, s.stale, nil
}
func (s *swrSpyCache) GetListSWR(_ context.Context) ([]byte, bool, error) { return nil, false, nil }
func (s *swrSpyCache) TryRefreshTicket(_ context.Context, _ string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lockHeld {
		return false, nil
	}
	s.lockHeld = true
	atomic.AddInt32(&s.refreshes, 1)
	return true, nil
}
func (s *swrSpyCache) GetListSWRRefresh()                             {}
func (s *swrSpyCache) TryRefreshList(_ context.Context) (bool, error) { return true, nil }

func TestCachingRepo_SWR_FreshServedWithoutRefresh(t *testing.T) {
	spy := &swrSpyCache{ticketData: []byte(`{"ID":"t1","Title":"Hot"}`), stale: false}
	inner := &fakeInnerRepo{ticketByID: func(id string) *Ticket { return &Ticket{ID: id} }}
	repo := NewCachingTicketRepository(inner, spy, zap.NewNop())

	got, err := repo.FindByID(context.Background(), "t1")
	require.NoError(t, err)
	assert.Equal(t, "t1", got.ID)
	assert.Equal(t, int32(0), atomic.LoadInt32(&spy.refreshes), "fresh hit must not refresh")
}

func TestCachingRepo_SWR_StaleServedAndRefreshedOnce(t *testing.T) {
	spy := &swrSpyCache{ticketData: []byte(`{"ID":"t1","Title":"Stale"}`), stale: true}
	var innerCalls int32
	inner := &fakeInnerRepo{ticketByID: func(id string) *Ticket {
		atomic.AddInt32(&innerCalls, 1)
		return &Ticket{ID: id, Title: "Fresh"}
	}}
	repo := NewCachingTicketRepository(inner, spy, zap.NewNop())

	got, err := repo.FindByID(context.Background(), "t1")
	require.NoError(t, err)
	assert.Equal(t, "Stale", got.Title, "stale value is served immediately to the caller")

	assert.Eventually(t, func() bool {
		return atomic.LoadInt32(&spy.refreshes) == 1 && atomic.LoadInt32(&innerCalls) == 1
	}, time.Second, 10*time.Millisecond, "exactly one background refresh must run")
}

func TestCachingRepo_FindAll_CoalescesConcurrentMisses(t *testing.T) {
	var calls int32
	inner := &fakeInnerRepo{release: make(chan struct{})}
	// Override FindAll via a wrapper inner that counts and blocks.
	wrapped := &listInner{fakeInnerRepo: inner, calls: &calls}
	repo := NewCachingTicketRepository(wrapped, NewNoopAwareSpy(), zap.NewNop())

	fireConcurrent(15, inner.release, func(i int) {
		_, err := repo.FindAll(context.Background(), PaginationParams{})
		require.NoError(t, err)
	})
	assert.Equal(t, int32(1), atomic.LoadInt32(&calls), "concurrent list misses collapse to one load")
}

// listInner adds a blocking, counting FindAll to fakeInnerRepo.
type listInner struct {
	*fakeInnerRepo
	calls *int32
}

func (l *listInner) FindAll(_ context.Context, _ PaginationParams) ([]*Ticket, error) {
	atomic.AddInt32(l.calls, 1)
	<-l.fakeInnerRepo.release
	return []*Ticket{{ID: "t1"}}, nil
}

// NewNoopAwareSpy returns a cache that always misses (forces the load path).
func NewNoopAwareSpy() *swrSpyCache { return &swrSpyCache{} }

// invSpy counts invalidations on top of the always-miss spy.
type invSpy struct {
	swrSpyCache
	invTicket int32
	invList   int32
}

func (s *invSpy) InvalidateTicket(_ context.Context, _ string) error {
	atomic.AddInt32(&s.invTicket, 1)
	return nil
}
func (s *invSpy) InvalidateList(_ context.Context) error {
	atomic.AddInt32(&s.invList, 1)
	return nil
}

func TestCachingRepo_ReservationLifecycle_DoesNotInvalidateMetadata(t *testing.T) {
	spy := &invSpy{}
	inner := &reservationInner{}
	repo := NewCachingTicketRepository(inner, spy, zap.NewNop())

	require.NoError(t, repo.ReserveTicket(context.Background(), "t1", "o1"))
	require.NoError(t, repo.ReleaseTicket(context.Background(), "t1"))
	require.NoError(t, repo.CreateReservation(context.Background(), &TicketReservation{TicketID: "t1"}))
	require.NoError(t, repo.FinalizeReservation(context.Background(), "r1", "o1"))
	require.NoError(t, repo.ReleaseReservation(context.Background(), "r1"))

	assert.Equal(t, int32(0), atomic.LoadInt32(&spy.invTicket), "reservation lifecycle must not invalidate metadata")
	assert.Equal(t, int32(0), atomic.LoadInt32(&spy.invList))
}

func TestCachingRepo_OrganizerEdit_StillInvalidates(t *testing.T) {
	spy := &invSpy{}
	inner := &reservationInner{}
	repo := NewCachingTicketRepository(inner, spy, zap.NewNop())

	require.NoError(t, repo.Update(context.Background(), &Ticket{ID: "t1"}))
	assert.Equal(t, int32(1), atomic.LoadInt32(&spy.invTicket), "organizer edit must invalidate the ticket")
	assert.Equal(t, int32(1), atomic.LoadInt32(&spy.invList))
}

// reservationInner is a no-op inner repo for reservation/update calls.
type reservationInner struct{ TicketRepository }

func (reservationInner) ReserveTicket(context.Context, string, string) error         { return nil }
func (reservationInner) ReleaseTicket(context.Context, string) error                 { return nil }
func (reservationInner) CreateReservation(context.Context, *TicketReservation) error { return nil }
func (reservationInner) FinalizeReservation(context.Context, string, string) error   { return nil }
func (reservationInner) ReleaseReservation(context.Context, string) error            { return nil }
func (reservationInner) Update(context.Context, *Ticket) error                       { return nil }
func (reservationInner) FindReservationByID(context.Context, string) (*TicketReservation, error) {
	return &TicketReservation{TicketID: "t1"}, nil
}
