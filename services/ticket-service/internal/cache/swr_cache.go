package cache

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	ticketSoftTTL  = 5 * time.Second
	ticketHardTTL  = 60 * time.Second
	listSoftTTL    = 5 * time.Second
	listHardTTL    = 30 * time.Second
	refreshLockTTL = 10 * time.Second
)

// swrEnvelope wraps the cached payload with a soft-expiry timestamp. The Redis
// key's physical TTL is the hard TTL; SoftExpiresAtMs marks logical freshness.
type swrEnvelope struct {
	SoftExpiresAtMs int64           `json:"s"`
	Data            json.RawMessage `json:"d"`
}

// RedisSWRCache is a shared-Redis stale-while-revalidate cache. All state
// (values, soft-expiry, refresh locks) lives in Redis, so it is coherent across
// pods — no per-pod memory.
type RedisSWRCache struct {
	client *redis.Client
	now    func() time.Time
}

func NewRedisSWRCache(client *redis.Client) *RedisSWRCache {
	return &RedisSWRCache{client: client, now: time.Now}
}

func lockKey(key string) string { return key + ":lock" }

func (c *RedisSWRCache) store(ctx context.Context, key string, data []byte, soft, hard time.Duration) error {
	env := swrEnvelope{
		SoftExpiresAtMs: c.now().Add(soft).UnixMilli(),
		Data:            json.RawMessage(data),
	}
	blob, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return c.client.Set(ctx, key, blob, hard).Err()
}

func (c *RedisSWRCache) load(ctx context.Context, key string) (data []byte, stale bool, err error) {
	blob, err := c.client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var env swrEnvelope
	if err := json.Unmarshal(blob, &env); err != nil {
		return nil, false, err
	}
	stale = c.now().UnixMilli() >= env.SoftExpiresAtMs
	return env.Data, stale, nil
}

func (c *RedisSWRCache) tryRefreshLock(ctx context.Context, key string) (bool, error) {
	return c.client.SetNX(ctx, lockKey(key), "1", refreshLockTTL).Result()
}

// --- TicketCache (plain, back-compatible) ---

func (c *RedisSWRCache) GetTicket(ctx context.Context, id string) ([]byte, error) {
	data, _, err := c.load(ctx, ticketKey(id))
	return data, err
}

func (c *RedisSWRCache) SetTicket(ctx context.Context, id string, data []byte) error {
	return c.store(ctx, ticketKey(id), data, ticketSoftTTL, ticketHardTTL)
}

func (c *RedisSWRCache) GetList(ctx context.Context) ([]byte, error) {
	data, _, err := c.load(ctx, listKey())
	return data, err
}

func (c *RedisSWRCache) SetList(ctx context.Context, data []byte) error {
	return c.store(ctx, listKey(), data, listSoftTTL, listHardTTL)
}

func (c *RedisSWRCache) InvalidateTicket(ctx context.Context, id string) error {
	return c.client.Del(ctx, ticketKey(id)).Err()
}

func (c *RedisSWRCache) InvalidateList(ctx context.Context) error {
	return c.client.Del(ctx, listKey()).Err()
}

// --- SWRTicketCache (staleness-aware) ---

func (c *RedisSWRCache) GetTicketSWR(ctx context.Context, id string) ([]byte, bool, error) {
	return c.load(ctx, ticketKey(id))
}

func (c *RedisSWRCache) GetListSWR(ctx context.Context) ([]byte, bool, error) {
	return c.load(ctx, listKey())
}

func (c *RedisSWRCache) TryRefreshTicket(ctx context.Context, id string) (bool, error) {
	return c.tryRefreshLock(ctx, ticketKey(id))
}

func (c *RedisSWRCache) TryRefreshList(ctx context.Context) (bool, error) {
	return c.tryRefreshLock(ctx, listKey())
}

var _ SWRTicketCache = (*RedisSWRCache)(nil)
