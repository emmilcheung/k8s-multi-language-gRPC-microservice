package repository

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// fakeInnerRepo implements TicketRepository by embedding the interface (unused
// methods stay nil) and overriding only the read paths under test.
type fakeInnerRepo struct {
	TicketRepository
	release       chan struct{}
	findByIDCalls int32
	ticketByID    func(id string) *Ticket
}

func (f *fakeInnerRepo) FindByID(_ context.Context, id string) (*Ticket, error) {
	atomic.AddInt32(&f.findByIDCalls, 1)
	if f.release != nil {
		<-f.release
	}
	return f.ticketByID(id), nil
}

func fireConcurrent(n int, release chan struct{}, fn func(i int)) {
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			fn(i)
		}(i)
	}
	close(start)
	time.Sleep(50 * time.Millisecond)
	if release != nil {
		close(release)
	}
	wg.Wait()
}
