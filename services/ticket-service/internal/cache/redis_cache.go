package cache

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	keyPrefix = "ticket-service"
	ticketTTL = 60 * time.Second
	listTTL   = 30 * time.Second
)

func ticketKey(id string) string {
	return keyPrefix + ":ticket:" + id
}

func listKey() string {
	return keyPrefix + ":tickets:list"
}

type RedisCache struct {
	client *redis.Client
}

func NewRedisCache(client *redis.Client) *RedisCache {
	return &RedisCache{client: client}
}

func (c *RedisCache) GetTicket(ctx context.Context, id string) ([]byte, error) {
	data, err := c.client.Get(ctx, ticketKey(id)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

func (c *RedisCache) SetTicket(ctx context.Context, id string, data []byte) error {
	return c.client.Set(ctx, ticketKey(id), data, ticketTTL).Err()
}

func (c *RedisCache) GetList(ctx context.Context) ([]byte, error) {
	data, err := c.client.Get(ctx, listKey()).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

func (c *RedisCache) SetList(ctx context.Context, data []byte) error {
	return c.client.Set(ctx, listKey(), data, listTTL).Err()
}

func (c *RedisCache) InvalidateTicket(ctx context.Context, id string) error {
	return c.client.Del(ctx, ticketKey(id)).Err()
}

func (c *RedisCache) InvalidateList(ctx context.Context) error {
	return c.client.Del(ctx, listKey()).Err()
}
