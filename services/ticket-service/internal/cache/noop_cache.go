package cache

import "context"

type NoopCache struct{}

func NewNoopCache() *NoopCache {
	return &NoopCache{}
}

func (c *NoopCache) GetTicket(_ context.Context, _ string) ([]byte, error) { return nil, nil }
func (c *NoopCache) SetTicket(_ context.Context, _ string, _ []byte) error { return nil }
func (c *NoopCache) GetList(_ context.Context) ([]byte, error)             { return nil, nil }
func (c *NoopCache) SetList(_ context.Context, _ []byte) error             { return nil }
func (c *NoopCache) InvalidateTicket(_ context.Context, _ string) error    { return nil }
func (c *NoopCache) InvalidateList(_ context.Context) error                { return nil }
