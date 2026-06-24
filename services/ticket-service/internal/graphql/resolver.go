package graph

import (
	"strconv"
	"time"

	"github.com/acme/ticket-service/internal/config"
	"github.com/acme/ticket-service/internal/metrics"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	"go.uber.org/zap"
)

// Resolver is the root resolver that holds service dependencies.
type Resolver struct {
	TicketService *service.TicketService
	Config        *config.Config
	Log           *zap.Logger
	SearchMetrics *metrics.SearchMetrics
}

// mapTicketToGQL converts a repository.Ticket to the generated GQL Ticket model.
func mapTicketToGQL(t *repository.Ticket) *Ticket {
	priceF, _ := strconv.ParseFloat(t.Price, 64)
	price := int(priceF)
	available := t.Quota - t.Reserved - t.Sold
	if available < 0 {
		available = 0
	}

	ticketType := TicketTypeGeneralAdmission
	if t.TicketType == "SEATED_MANUAL" || t.TicketType == "SEATED_AUTO" {
		ticketType = TicketTypeSeated
	}

	category := TicketCategoryOther
	if t.Category != "" {
		switch t.Category {
		case "CONCERT":
			category = TicketCategoryConcert
		case "SPORTS":
			category = TicketCategorySports
		case "COMEDY":
			category = TicketCategoryComedy
		case "THEATRE":
			category = TicketCategoryTheatre
		case "FESTIVAL":
			category = TicketCategoryFestival
		case "OTHER":
			category = TicketCategoryOther
		}
	}

	result := &Ticket{
		ID:           t.ID,
		Title:        t.Title,
		Price:        price,
		PriceDecimal: t.Price,
		UserID:       t.UserID,
		Quota:        t.Quota,
		Reserved:     t.Reserved,
		Sold:         t.Sold,
		Available:    available,
		TicketType:   ticketType,
		Category:     category,
		SavedByMe:    false,
		CreatedAt:    t.CreatedAt.Format(time.RFC3339),
		UpdatedAt:    t.UpdatedAt.Format(time.RFC3339),
	}

	if t.MaxPerUser > 0 {
		maxPerUser := t.MaxPerUser
		result.MaxPerUser = &maxPerUser
	}

	if t.SeatingPlanID != "" {
		result.SeatingPlan = &SeatingPlan{ID: t.SeatingPlanID}
	}
	if t.OrderID != "" {
		orderID := t.OrderID
		result.OrderID = &orderID
	}
	if t.Event != nil {
		event := &TicketEvent{
			Title:    t.Event.Title,
			StartsAt: t.Event.StartsAt.Format(time.RFC3339),
		}
		if t.Event.Description != "" {
			description := t.Event.Description
			event.Description = &description
		}
		if t.Event.EndsAt != nil {
			endsAt := t.Event.EndsAt.Format(time.RFC3339)
			event.EndsAt = &endsAt
		}
		if t.Event.ImageURL != "" {
			imageURL := t.Event.ImageURL
			event.ImageURL = &imageURL
		}
		if t.Event.VenueName != "" {
			venueName := t.Event.VenueName
			event.VenueName = &venueName
		}
		if t.Event.VenueAddress != "" {
			venueAddress := t.Event.VenueAddress
			event.VenueAddress = &venueAddress
		}
		result.Event = event
	}

	return result
}
