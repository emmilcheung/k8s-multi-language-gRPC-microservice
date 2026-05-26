package graph

import (
	"context"
	"time"

	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/repository"
)

// priceTierRepository is the subset of the price-tier repo used by GraphQL resolvers.
type priceTierRepository interface {
	Create(ctx context.Context, t *repository.PriceTier) error
	ListByPlan(ctx context.Context, planID string) ([]*repository.PriceTier, error)
}

// holdManager is the subset of hold.Manager used by GraphQL resolvers.
type holdManager interface {
	HoldSeats(ctx context.Context, planID, userID, sessionID string, seatIDs []string) (*hold.HoldResult, error)
	ReleaseHold(ctx context.Context, planID, userID string, seatIDs []string) error
}

// Resolver is the root resolver wired with data-access dependencies.
type Resolver struct {
	PlanRepo         repository.PlanRepository
	SectionRepo      repository.SectionRepository
	VenueRepo        repository.VenueRepository
	VenueSectionRepo repository.VenueSectionRepository
	PriceTierRepo    priceTierRepository
	HoldMgr          holdManager
}

// ── mapping helpers ───────────────────────────────────────────────────────────

func mapVenueToGQL(v *repository.Venue) *Venue {
	return &Venue{
		ID:          v.ID,
		OrganizerID: v.OrganizerID,
		Name:        v.Name,
		Capacity:    v.Capacity,
		Timezone:    v.Timezone,
		Address:     v.Address,
	}
}

func mapVenueSectionToGQL(vs *repository.VenueSection) *VenueSection {
	sectionType := SectionTypeSeated
	if vs.Type == repository.SectionTypeGA {
		sectionType = SectionTypeGa
	}
	capacity := vs.RowCount * vs.ColumnCount
	if vs.Type == repository.SectionTypeGA {
		capacity = vs.ColumnCount
	}
	return &VenueSection{
		ID:           vs.ID,
		VenueID:      vs.VenueID,
		Name:         vs.Name,
		Type:         sectionType,
		RowCount:     vs.RowCount,
		ColumnCount:  vs.ColumnCount,
		DisplayOrder: vs.DisplayOrder,
		Capacity:     capacity,
	}
}

func mapPriceTierToGQL(t *repository.PriceTier) *PriceTier {
	return &PriceTier{
		ID:     t.ID,
		PlanID: t.PlanID,
		Name:   t.Name,
		Price:  t.Price,
	}
}

// mapPlanToGQL converts a domain SeatingPlan to the GraphQL model, eagerly
// attaching pre-loaded sections.  Pass nil sections to get an empty slice.
func mapPlanToGQL(plan *repository.SeatingPlan, sections []*Section) *SeatingPlan {
	assignmentMode := AssignmentModeManual
	if plan.AssignmentMode == "auto" {
		assignmentMode = AssignmentModeAuto
	}

	status := PlanStatusDraft
	switch plan.Status {
	case repository.PlanStatusActive:
		status = PlanStatusActive
	case repository.PlanStatusInactive:
		status = PlanStatusArchived
	}

	gqlSections := sections
	if gqlSections == nil {
		gqlSections = []*Section{}
	}

	return &SeatingPlan{
		ID:             plan.ID,
		Sections:       gqlSections,
		AssignmentMode: assignmentMode,
		Status:         status,
	}
}

// mapSectionToGQL converts a domain Section + pre-loaded seats to the GraphQL
// model, computing availableSeats inline.
func mapSectionToGQL(sec *repository.Section, seats []*Seat) *Section {
	available := 0
	for _, s := range seats {
		if s.Status == SeatStatusAvailable {
			available++
		}
	}
	return &Section{
		ID:             sec.ID,
		Name:           sec.Name,
		Seats:          seats,
		AvailableSeats: available,
	}
}

// loadSections fetches all sections for a plan and their seats, returning
// fully-populated []*Section ready for the GraphQL response.
func loadSections(ctx context.Context, sectionRepo repository.SectionRepository, planID string) ([]*Section, error) {
	dbSections, err := sectionRepo.ListSectionsByPlan(ctx, planID)
	if err != nil {
		return nil, err
	}
	result := make([]*Section, len(dbSections))
	for i, s := range dbSections {
		seats, err := sectionRepo.FindSeatsBySection(ctx, s.ID)
		if err != nil {
			return nil, err
		}
		gqlSeats := make([]*Seat, len(seats))
		for j, seat := range seats {
			status := SeatStatusAvailable
			switch seat.Status {
			case repository.SeatStatusHeld:
				status = SeatStatusHeld
			case repository.SeatStatusSold, repository.SeatStatusReserved, repository.SeatStatusBlocked:
				status = SeatStatusSold
			}
			gqlSeats[j] = &Seat{
				ID:     seat.ID,
				Label:  seat.SeatLabel,
				Price:  0, // PriceTier lookup deferred
				Status: status,
			}
		}
		result[i] = mapSectionToGQL(s, gqlSeats)
	}
	return result, nil
}

// loadPlanWithSections loads a plan and eagerly fetches its sections.
func loadPlanWithSections(ctx context.Context, planRepo repository.PlanRepository, sectionRepo repository.SectionRepository, id string) (*SeatingPlan, error) {
	plan, err := planRepo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	sections, err := loadSections(ctx, sectionRepo, plan.ID)
	if err != nil {
		return nil, err
	}
	return mapPlanToGQL(plan, sections), nil
}

// holdResultToGQL converts a hold.HoldResult to the GraphQL SeatHoldResult.
func holdResultToGQL(r *hold.HoldResult) *SeatHoldResult {
	return &SeatHoldResult{
		Held:      r.Held,
		ExpiresAt: r.ExpiresAt.Format(time.RFC3339),
	}
}
