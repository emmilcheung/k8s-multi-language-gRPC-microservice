package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/acme/ticket-service/internal/authz"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	"go.uber.org/zap"
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

// pageSize applies the same default (20) and cap (100) as ticketsConnection.
func pageSize(first *int) int {
	limit := 20
	if first != nil && *first > 0 {
		limit = *first
	}
	if limit > 100 {
		limit = 100
	}
	return limit
}

func pageInfo[E any](edges []*E, hasNext bool, cursor func(*E) string) *PageInfo {
	info := &PageInfo{HasNextPage: hasNext}
	if len(edges) > 0 {
		c := cursor(edges[len(edges)-1])
		info.EndCursor = &c
	}
	return info
}

// jsonOrNil renders changed-field maps as a JSON string, or nil when empty.
func jsonOrNil(m map[string]any) *string {
	if len(m) == 0 {
		return nil
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	s := string(raw)
	return &s
}

func mapHistoryEntry(row repository.AuditRecord) *EventHistoryEntry {
	entry := &EventHistoryEntry{
		ID:          row.ID,
		At:          row.At.UTC().Format(time.RFC3339),
		ActorUserID: row.ActorUserID,
		Action:      row.Action,
		Before:      jsonOrNil(row.Before),
		After:       jsonOrNil(row.After),
	}
	if row.ActorAccountID != "" {
		id := row.ActorAccountID
		entry.ActorAccountID = &id
	}
	if row.Reason != "" {
		reason := row.Reason
		entry.Reason = &reason
	}
	return entry
}

// organizerError wraps a service error for the client. Failures of the
// permission check carry internal detail (addresses, rpc text), so the client
// gets a generic message and the cause goes to the log.
func (r *Resolver) organizerError(op string, err error) error {
	switch {
	case errors.Is(err, authz.ErrAuthzUnavailable):
		return fmt.Errorf("%s: permission service is temporarily unavailable", op)
	case errors.Is(err, service.ErrPermissionCheckFailed):
		if r.Log != nil {
			r.Log.Error("permission check failed", zap.String("operation", op), zap.Error(err))
		}
		return fmt.Errorf("%s: an unexpected error occurred", op)
	}
	return fmt.Errorf("%s: %w", op, err)
}
