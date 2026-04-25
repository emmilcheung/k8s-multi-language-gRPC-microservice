package graph

import (
	"context"

	"github.com/acme/venue-service/internal/repository"
)

// Resolver is the root resolver wired with data-access dependencies.
type Resolver struct {
	PlanRepo    repository.PlanRepository
	SectionRepo repository.SectionRepository
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
		// Map inactive → archived for the GraphQL enum surface.
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
