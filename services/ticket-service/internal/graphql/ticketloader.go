package graph

import (
	"context"
	"errors"
	"fmt"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	dataloader "github.com/graph-gophers/dataloader/v7"
)

// contextKey is an unexported type used to store per-request values in a
// context without colliding with keys from other packages.
type contextKey string

const ticketLoaderKey contextKey = "ticketLoader"

// ticketBatchFn is the DataLoader batch function.  It receives all ticket IDs
// queued during one event-loop tick and fetches them in a single
// FindByIDs query, then fans results back in input order.
func ticketBatchFn(svc *service.TicketService) dataloader.BatchFunc[string, *Ticket] {
	return func(ctx context.Context, keys []string) []*dataloader.Result[*Ticket] {
		tickets, err := svc.GetTicketsByIDs(ctx, keys)
		results := make([]*dataloader.Result[*Ticket], len(keys))
		if err != nil {
			for i := range keys {
				results[i] = &dataloader.Result[*Ticket]{Error: fmt.Errorf("ticketloader: %w", err)}
			}
			return results
		}
		for i, t := range tickets {
			if t == nil {
				results[i] = &dataloader.Result[*Ticket]{Error: nil, Data: nil}
			} else {
				results[i] = &dataloader.Result[*Ticket]{Data: mapTicketToGQL(t)}
			}
		}
		return results
	}
}

// NewTicketLoader constructs a per-request DataLoader backed by the given service.
func NewTicketLoader(svc *service.TicketService) *dataloader.Loader[string, *Ticket] {
	return dataloader.NewBatchedLoader(ticketBatchFn(svc))
}

// WithTicketLoader stores a loader instance in the context.
func WithTicketLoader(ctx context.Context, loader *dataloader.Loader[string, *Ticket]) context.Context {
	return context.WithValue(ctx, ticketLoaderKey, loader)
}

// TicketLoaderFrom retrieves the per-request loader from the context.
// It panics if the loader was not stored — this is a programmer error that
// should be caught during development.
func TicketLoaderFrom(ctx context.Context) *dataloader.Loader[string, *Ticket] {
	loader, ok := ctx.Value(ticketLoaderKey).(*dataloader.Loader[string, *Ticket])
	if !ok || loader == nil {
		panic("ticketloader: not found in context — did you forget to attach the middleware?")
	}
	return loader
}

// loadTicket pulls one ticket through the per-request loader.
// A nil result with no error means the ticket does not exist (caller returns nil).
func loadTicket(ctx context.Context, id string) (*Ticket, error) {
	loader := TicketLoaderFrom(ctx)
	thunk := loader.Load(ctx, id)
	ticket, err := thunk()
	if err != nil {
		if errors.Is(err, repository.ErrTicketNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return ticket, nil
}
