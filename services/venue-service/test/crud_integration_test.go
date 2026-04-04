package test

import (
	"context"
	"testing"

	"github.com/acme/venue-service/internal/migrations"
	"github.com/acme/venue-service/internal/repository"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"go.uber.org/zap"
)

// TestCRUD_ShouldSupportFullVenuePlanLifecycle runs the full organizer lifecycle:
//
//	create venue → create plan → create section → create price tier
//	→ attach ticket → activate
//
// It also verifies idempotency and conflict guards on activate and attach.
func TestCRUD_ShouldSupportFullVenuePlanLifecycle(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx := context.Background()

	pgContainer, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("venue_test"),
		tcpostgres.WithUsername("venue_user"),
		tcpostgres.WithPassword("venue_pass"),
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err, "failed to start PostgreSQL container")
	t.Cleanup(func() {
		if termErr := pgContainer.Terminate(ctx); termErr != nil {
			t.Logf("warn: failed to terminate postgres container: %v", termErr)
		}
	})

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	require.NoError(t, migrations.Run(connStr, zap.NewNop()))

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)
	defer pool.Close()

	venueRepo := pgrepo.NewVenueRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	priceTierRepo := pgrepo.NewPriceTierRepo(pool)

	const organizerID = "00000000-0000-0000-0000-000000000001"
	const ticketID = "00000000-0000-0000-0000-000000000002"
	const otherTicketID = "00000000-0000-0000-0000-000000000003"

	// ── Step 1: create venue ─────────────────────────────────────────────────
	v := &repository.Venue{
		OrganizerID: organizerID,
		Name:        "Test Arena",
		Capacity:    1000,
		Timezone:    "UTC",
	}
	require.NoError(t, venueRepo.Create(ctx, v))
	assert.NotEmpty(t, v.ID)
	assert.False(t, v.CreatedAt.IsZero())

	// Round-trip read.
	fetched, err := venueRepo.FindByID(ctx, v.ID)
	require.NoError(t, err)
	assert.Equal(t, "Test Arena", fetched.Name)

	// List by organizer.
	venues, err := venueRepo.ListByOrganizer(ctx, organizerID)
	require.NoError(t, err)
	assert.Len(t, venues, 1)

	// Update venue.
	v.Name = "Updated Arena"
	require.NoError(t, venueRepo.Update(ctx, v))
	updated, err := venueRepo.FindByID(ctx, v.ID)
	require.NoError(t, err)
	assert.Equal(t, "Updated Arena", updated.Name)

	// ── Step 2: create seating plan (draft, no ticket yet) ───────────────────
	p := &repository.SeatingPlan{
		VenueID:          v.ID,
		OrganizerID:      organizerID,
		Name:             "Main Floor",
		MaxSeatsPerOrder: 4,
	}
	require.NoError(t, planRepo.Create(ctx, p))
	assert.NotEmpty(t, p.ID)
	assert.Equal(t, repository.PlanStatusDraft, p.Status)
	assert.Equal(t, 1, p.Version)

	// Fetch plan.
	fetchedPlan, err := planRepo.FindByID(ctx, p.ID)
	require.NoError(t, err)
	assert.Equal(t, "Main Floor", fetchedPlan.Name)
	assert.Empty(t, fetchedPlan.TicketID, "ticket_id should be empty before attach")

	// ── Step 3: create section ───────────────────────────────────────────────
	sec := &repository.Section{
		PlanID:      p.ID,
		Name:        "Floor A",
		Type:        repository.SectionTypeSeated,
		RowCount:    10,
		ColumnCount: 20,
	}
	require.NoError(t, sectionRepo.CreateSection(ctx, sec))
	assert.NotEmpty(t, sec.ID)

	sections, err := sectionRepo.ListSectionsByPlan(ctx, p.ID)
	require.NoError(t, err)
	require.Len(t, sections, 1)
	assert.Equal(t, "Floor A", sections[0].Name)

	// ── Step 4: create price tier ────────────────────────────────────────────
	tier := &repository.PriceTier{
		PlanID: p.ID,
		Name:   "Standard",
		Price:  "75.00",
	}
	require.NoError(t, priceTierRepo.Create(ctx, tier))
	assert.NotEmpty(t, tier.ID)

	tiers, err := priceTierRepo.ListByPlan(ctx, p.ID)
	require.NoError(t, err)
	require.Len(t, tiers, 1)
	assert.Equal(t, "75.00", tiers[0].Price)

	// ── Step 5: activate without ticket should succeed ───────────────────────
	require.NoError(t, planRepo.Activate(ctx, p.ID, p.Version))

	activatedPlan, err := planRepo.FindByID(ctx, p.ID)
	require.NoError(t, err)
	assert.Equal(t, repository.PlanStatusActive, activatedPlan.Status)
	assert.Empty(t, activatedPlan.TicketID, "ticket_id should still be empty after activation")

	// ── Step 6: attach ticket ────────────────────────────────────────────────
	require.NoError(t, planRepo.AttachTicket(ctx, p.ID, ticketID, p.Version))

	attachedPlan, err := planRepo.FindByID(ctx, p.ID)
	require.NoError(t, err)
	assert.Equal(t, ticketID, attachedPlan.TicketID)

	// ── Step 7: version conflict on stale attach ──────────────────────────────
	err = planRepo.AttachTicket(ctx, p.ID, otherTicketID, 0 /* stale version */)
	assert.ErrorIs(t, err, repository.ErrVersionConflict,
		"attach with wrong version should return ErrVersionConflict")

	// ── Step 8: active plan remains active after attach ───────────────────────
	activatedPlan, err = planRepo.FindByID(ctx, p.ID)
	require.NoError(t, err)
	assert.Equal(t, repository.PlanStatusActive, activatedPlan.Status)

	// ── Step 9: idempotent activate (ErrPlanAlreadyActive) ───────────────────
	err = planRepo.Activate(ctx, p.ID, activatedPlan.Version)
	assert.ErrorIs(t, err, repository.ErrPlanAlreadyActive,
		"second activate should return ErrPlanAlreadyActive")

	// ── Step 10: not-found sentinel ──────────────────────────────────────────
	_, err = planRepo.FindByID(ctx, "00000000-0000-0000-0000-000000000000")
	assert.ErrorIs(t, err, repository.ErrPlanNotFound)

	_, err = venueRepo.FindByID(ctx, "00000000-0000-0000-0000-000000000000")
	assert.ErrorIs(t, err, repository.ErrVenueNotFound)
}
