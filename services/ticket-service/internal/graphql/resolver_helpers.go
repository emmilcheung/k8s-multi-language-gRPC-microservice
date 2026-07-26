package graph

import (
	"context"
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

// maxRefill caps worst-case OpenSearch fan-out iterations in the refill loop.
const maxRefill = 5

// ticketsConnectionMongo runs the Mongo-backed tickets page and is the fallback
// used by TicketsConnection when OpenSearch is unavailable or not configured.
// It observes search_query_duration_seconds{backend="mongo"} when SearchMetrics is wired.
func (r *queryResolver) ticketsConnectionMongo(ctx context.Context, filter *TicketFilter, limit int, cursorIn string) (*TicketConnection, error) {
	if r.SearchMetrics != nil {
		t0 := time.Now()
		defer func() { r.SearchMetrics.QueryDuration.WithLabelValues("mongo").Observe(time.Since(t0).Seconds()) }()
	}
	params := repository.PaginationParams{Limit: limit + 1}
	if cursorIn != "" {
		params.After = cursorIn
	}
	if filter != nil {
		if filter.AvailableOnly != nil {
			params.AvailableOnly = *filter.AvailableOnly
		}
		if filter.Search != nil {
			params.Search = *filter.Search
		}
		if filter.Category != nil {
			params.Category = string(*filter.Category)
		}
		if filter.MinPrice != nil {
			minPriceFloat := float64(*filter.MinPrice)
			params.MinPrice = &minPriceFloat
		}
		if filter.MaxPrice != nil {
			maxPriceFloat := float64(*filter.MaxPrice)
			params.MaxPrice = &maxPriceFloat
		}
	}

	tickets, err := r.TicketService.ListTickets(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("ticketsConnection: %w", err)
	}

	// Apply ticketType filter in-memory (repo doesn't accept it yet).
	if filter != nil && filter.TicketType != nil {
		filtered := tickets[:0]
		for _, t := range tickets {
			if string(t.TicketType) == string(*filter.TicketType) {
				filtered = append(filtered, t)
			}
		}
		tickets = filtered
	}

	hasNext := len(tickets) > limit
	if hasNext {
		tickets = tickets[:limit]
	}

	edges := make([]*TicketEdge, len(tickets))
	for i, t := range tickets {
		edges[i] = &TicketEdge{
			Node:   mapTicketToGQL(t),
			Cursor: fmt.Sprintf("%d:%s", t.CreatedAt.UnixMilli(), t.ID),
		}
	}

	var endCursor *string
	if len(edges) > 0 {
		c := edges[len(edges)-1].Cursor
		endCursor = &c
	}

	return &TicketConnection{
		Edges:    edges,
		PageInfo: &PageInfo{HasNextPage: hasNext, EndCursor: endCursor},
	}, nil
}
