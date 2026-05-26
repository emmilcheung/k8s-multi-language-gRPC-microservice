package graph

import (
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/acme/ticket-service/internal/repository"
)

func intPriceToDecimalString(price int) string {
	value := float64(price) / 100.0
	return strconv.FormatFloat(math.Round(value*100)/100, 'f', 2, 64)
}

func mapEventInput(in *TicketEventInput) (*repository.TicketEvent, error) {
	startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return nil, fmt.Errorf("invalid startsAt %q: %w", in.StartsAt, err)
	}
	ev := &repository.TicketEvent{StartsAt: startsAt}
	if in.Title != nil {
		ev.Title = *in.Title
	}
	if in.Description != nil {
		ev.Description = *in.Description
	}
	if in.EndsAt != nil {
		t, err := time.Parse(time.RFC3339, *in.EndsAt)
		if err != nil {
			return nil, fmt.Errorf("invalid endsAt %q: %w", *in.EndsAt, err)
		}
		ev.EndsAt = &t
	}
	if in.ImageURL != nil {
		ev.ImageURL = *in.ImageURL
	}
	if in.VenueName != nil {
		ev.VenueName = *in.VenueName
	}
	if in.VenueAddress != nil {
		ev.VenueAddress = *in.VenueAddress
	}
	return ev, nil
}
