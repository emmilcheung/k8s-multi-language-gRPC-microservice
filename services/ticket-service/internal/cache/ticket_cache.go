package cache

import "context"

type TicketCache interface {
	GetTicket(ctx context.Context, id string) ([]byte, error)
	SetTicket(ctx context.Context, id string, data []byte) error

	GetList(ctx context.Context) ([]byte, error)
	SetList(ctx context.Context, data []byte) error

	InvalidateTicket(ctx context.Context, id string) error
	InvalidateList(ctx context.Context) error
}

// SWRTicketCache extends TicketCache with stale-while-revalidate semantics.
// GetTicketSWR/GetListSWR report whether a present entry is past its soft TTL
// (stale but still serveable); TryRefreshTicket/TryRefreshList acquire a
// fleet-wide refresh lock so exactly one caller rebuilds a stale entry.
type SWRTicketCache interface {
	TicketCache
	GetTicketSWR(ctx context.Context, id string) (data []byte, stale bool, err error)
	GetListSWR(ctx context.Context) (data []byte, stale bool, err error)
	TryRefreshTicket(ctx context.Context, id string) (acquired bool, err error)
	TryRefreshList(ctx context.Context) (acquired bool, err error)
}
