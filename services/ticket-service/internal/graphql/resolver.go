package graph

import (
	"strconv"
	"time"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
)

// Resolver is the root resolver that holds service dependencies.
type Resolver struct {
	TicketService *service.TicketService
}

// mapTicketToGQL converts a repository.Ticket to the generated GQL Ticket model.
func mapTicketToGQL(t *repository.Ticket) *Ticket {
	price, _ := strconv.Atoi(t.Price)
	available := t.Quota - t.Reserved - t.Sold
	if available < 0 {
		available = 0
	}

	ticketType := TicketTypeGeneralAdmission
	if t.TicketType == "SEATED_MANUAL" || t.TicketType == "SEATED_AUTO" {
		ticketType = TicketTypeSeated
	}

	result := &Ticket{
		ID:         t.ID,
		Title:      t.Title,
		Price:      price,
		Quota:      t.Quota,
		Available:  available,
		TicketType: ticketType,
		CreatedAt:  t.CreatedAt.Format(time.RFC3339),
		UpdatedAt:  t.UpdatedAt.Format(time.RFC3339),
	}

	if t.MaxPerUser > 0 {
		maxPerUser := t.MaxPerUser
		result.MaxPerUser = &maxPerUser
	}

	if t.SeatingPlanID != "" {
		result.SeatingPlan = &SeatingPlan{ID: t.SeatingPlanID}
	}

	return result
}
