package search

import (
	"testing"

	"github.com/acme/ticket-service/internal/kafka"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestEventToDoc_MapsAllFields(t *testing.T) {
	data := kafka.TicketEventData{
		ID:            "tk-abc",
		Title:         "VIP Pass",
		Price:         "99.50",
		Category:      "concert",
		TicketType:    "SEATED_MANUAL",
		SeatingPlanID: "sp-1",
		Version:       5,
		CreatedAt:     "2026-06-01T00:00:00Z",
		Event: &kafka.EventData{
			Title:        "Eras Tour",
			Description:  "Best show ever",
			StartsAt:     "2026-07-01T20:00:00Z",
			VenueName:    "Madison Square Garden",
			VenueAddress: "4 Pennsylvania Plaza, New York",
		},
	}

	doc := eventToDoc(data, zap.NewNop())

	require.Equal(t, "tk-abc", doc.ID)
	require.Equal(t, 5, doc.Version)
	require.Equal(t, "VIP Pass", doc.Title)
	require.Equal(t, 99.50, doc.Price)
	require.Equal(t, "concert", doc.Category)
	require.Equal(t, "SEATED_MANUAL", doc.TicketType)
	require.Equal(t, "sp-1", doc.SeatingPlanID)
	require.Equal(t, "2026-06-01T00:00:00Z", doc.CreatedAt)
	// Event fields
	require.Equal(t, "Eras Tour", doc.EventTitle)
	require.Equal(t, "Best show ever", doc.Description)
	require.Equal(t, "2026-07-01T20:00:00Z", doc.StartsAt)
	require.Equal(t, "Madison Square Garden", doc.VenueName)
	require.Equal(t, "4 Pennsylvania Plaza, New York", doc.VenueAddress)
}

func TestEventToDoc_NilEvent_ZeroesEventFields(t *testing.T) {
	data := kafka.TicketEventData{
		ID:        "tk-ga",
		Title:     "GA Ticket",
		Price:     "25.00",
		Category:  "festival",
		Version:   1,
		CreatedAt: "2026-05-01T00:00:00Z",
		Event:     nil,
	}

	doc := eventToDoc(data, zap.NewNop())

	require.Equal(t, "tk-ga", doc.ID)
	require.Equal(t, "GA Ticket", doc.Title)
	require.Equal(t, 25.00, doc.Price)
	// Event fields must be empty strings — not panicking with nil dereference.
	require.Empty(t, doc.EventTitle)
	require.Empty(t, doc.VenueName)
	require.Empty(t, doc.Description)
	require.Empty(t, doc.VenueAddress)
	require.Empty(t, doc.StartsAt)
}

func TestEventToDoc_InvalidPrice_DefaultsToZero(t *testing.T) {
	data := kafka.TicketEventData{
		ID:      "tk-bad",
		Price:   "not-a-number",
		Version: 1,
	}

	doc := eventToDoc(data, zap.NewNop())

	require.Equal(t, 0.0, doc.Price, "unparseable price must default to 0.0 without panicking")
}
