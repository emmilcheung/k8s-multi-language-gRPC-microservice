package hold

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// During an onsale every seat click is a hold; asking ticket-service each time
// would make it a hard dependency of seat selection.
func TestCachedSeatLimit_AsksTicketServiceOncePerTicketWithinTheTTL(t *testing.T) {
	calls := 0
	f := CachedSeatLimit(func(context.Context, *repository.SeatingPlan) (int, error) {
		calls++
		return 4, nil
	}, time.Minute)
	plan := &repository.SeatingPlan{TicketID: "t1"}

	for range 3 {
		limit, err := f(context.Background(), plan)
		require.NoError(t, err)
		assert.Equal(t, 4, limit)
	}
	assert.Equal(t, 1, calls)

	_, err := f(context.Background(), &repository.SeatingPlan{TicketID: "t2"})
	require.NoError(t, err)
	assert.Equal(t, 2, calls, "each ticket has its own limit")
}

// A ticket-service outage must not stop seat selection for a ticket whose
// limit is already known, but a limit that was never read cannot be guessed.
func TestCachedSeatLimit_KeepsTheLastKnownLimitWhenTicketServiceFails(t *testing.T) {
	down := false
	limit := 4
	f := CachedSeatLimit(func(context.Context, *repository.SeatingPlan) (int, error) {
		if down {
			return 0, errors.New("ticket-service unavailable")
		}
		return limit, nil
	}, time.Millisecond)
	plan := &repository.SeatingPlan{TicketID: "t1"}

	_, err := f(context.Background(), plan)
	require.NoError(t, err)

	down = true
	time.Sleep(5 * time.Millisecond)
	got, err := f(context.Background(), plan)
	require.NoError(t, err)
	assert.Equal(t, 4, got)

	_, err = f(context.Background(), &repository.SeatingPlan{TicketID: "never-seen"})
	assert.Error(t, err)

	// Once ticket-service is back, a changed limit is picked up.
	down, limit = false, 6
	got, err = f(context.Background(), plan)
	require.NoError(t, err)
	assert.Equal(t, 6, got)
}
