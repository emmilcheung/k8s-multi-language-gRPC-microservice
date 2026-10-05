package test

import (
	"context"
	"testing"

	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The waiting room pauses a sale instead of ending it only while seats can
// still come back, so the count has to separate seats a buyer can take now
// (including lapsed holds the sweeper has not released yet) from seats that
// are tied up, and ignore seats that are gone for good.
func TestTicketAvailability_CountsByWhatABuyerCanDo(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	ctx := context.Background()
	pool, planID, seatIDs := setupHoldFixture(t, ctx)
	defer pool.Close()
	repo := pgrepo.NewPlanRepo(pool)
	const ticketID = "00000000-0000-0000-0000-000000000002"

	// Fixture: three AVAILABLE seats on an active plan.
	got, err := repo.TicketAvailability(ctx, ticketID)
	require.NoError(t, err)
	assert.Equal(t, &repository.TicketAvailability{Available: 3, Held: 0}, got)

	// Mix of states: lapsed hold, live hold, reserved, plus a sold and a blocked seat.
	_, err = pool.Exec(ctx, `UPDATE seats SET status='HELD', held_by=gen_random_uuid(), held_until=now() - interval '1 minute' WHERE id=$1`, seatIDs[0])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE seats SET status='HELD', held_by=gen_random_uuid(), held_until=now() + interval '5 minutes' WHERE id=$1`, seatIDs[1])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE seats SET status='RESERVED', held_by=gen_random_uuid() WHERE id=$1`, seatIDs[2])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO seats (section_id, plan_id, seat_label, status)
		SELECT section_id, plan_id, 'S1', 'SOLD' FROM seats WHERE id=$1
		UNION ALL
		SELECT section_id, plan_id, 'B1', 'BLOCKED' FROM seats WHERE id=$1`, seatIDs[0])
	require.NoError(t, err)

	got, err = repo.TicketAvailability(ctx, ticketID)
	require.NoError(t, err)
	assert.Equal(t, 1, got.Available, "a lapsed hold is free to take, as HoldSeats treats it")
	assert.Equal(t, 2, got.Held, "a live hold and a reservation may still come back; sold and blocked seats never do")

	// A deactivated plan no longer counts, and a ticket with no active plan is not found.
	_, err = pool.Exec(ctx, `UPDATE seating_plans SET status='inactive' WHERE id=$1`, planID)
	require.NoError(t, err)
	_, err = repo.TicketAvailability(ctx, ticketID)
	assert.ErrorIs(t, err, repository.ErrPlanNotFound)

	_, err = repo.TicketAvailability(ctx, "00000000-0000-0000-0000-0000000000ff")
	assert.ErrorIs(t, err, repository.ErrPlanNotFound)
}
