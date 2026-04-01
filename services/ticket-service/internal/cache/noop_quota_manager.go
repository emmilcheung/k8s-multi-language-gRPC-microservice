package cache

import "context"

// NoopQuotaManager is a QuotaManager that always succeeds without touching
// Redis. Use it in unit tests that do not need Redis behaviour.
type NoopQuotaManager struct{}

// NewNoopQuotaManager returns a new NoopQuotaManager.
func NewNoopQuotaManager() *NoopQuotaManager { return &NoopQuotaManager{} }

func (n *NoopQuotaManager) Seed(_ context.Context, _ string, _ int, _ bool) error  { return nil }
func (n *NoopQuotaManager) Reserve(_ context.Context, _, _ string, _, _ int) error { return nil }
func (n *NoopQuotaManager) Release(_ context.Context, _, _ string, _ int) error    { return nil }
func (n *NoopQuotaManager) Finalize(_ context.Context, _, _ string, _ int) error   { return nil }
func (n *NoopQuotaManager) Available(_ context.Context, _ string) (int, error)     { return 0, nil }
