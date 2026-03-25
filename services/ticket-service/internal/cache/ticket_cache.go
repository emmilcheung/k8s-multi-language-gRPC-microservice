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
