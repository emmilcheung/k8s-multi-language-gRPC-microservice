package cache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestRedisCache(t *testing.T) (*RedisCache, *miniredis.Miniredis) {
	t.Helper()

	mr, err := miniredis.Run()
	require.NoError(t, err)

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() {
		_ = client.Close()
		mr.Close()
	})

	return NewRedisCache(client), mr
}

func TestGetTicket_miss_returns_nil(t *testing.T) {
	c, _ := newTestRedisCache(t)

	data, err := c.GetTicket(context.Background(), "missing")
	require.NoError(t, err)
	assert.Nil(t, data)
}

func TestGetTicket_after_SetTicket_returns_data(t *testing.T) {
	c, _ := newTestRedisCache(t)

	err := c.SetTicket(context.Background(), "t1", []byte(`{"id":"t1"}`))
	require.NoError(t, err)

	data, err := c.GetTicket(context.Background(), "t1")
	require.NoError(t, err)
	assert.Equal(t, []byte(`{"id":"t1"}`), data)
}

func TestGetList_miss_returns_nil(t *testing.T) {
	c, _ := newTestRedisCache(t)

	data, err := c.GetList(context.Background())
	require.NoError(t, err)
	assert.Nil(t, data)
}

func TestGetList_after_SetList_returns_data(t *testing.T) {
	c, _ := newTestRedisCache(t)

	err := c.SetList(context.Background(), []byte(`[{"id":"t1"}]`))
	require.NoError(t, err)

	data, err := c.GetList(context.Background())
	require.NoError(t, err)
	assert.Equal(t, []byte(`[{"id":"t1"}]`), data)
}

func TestInvalidateTicket_removes_key(t *testing.T) {
	c, _ := newTestRedisCache(t)

	err := c.SetTicket(context.Background(), "t1", []byte(`{"id":"t1"}`))
	require.NoError(t, err)

	err = c.InvalidateTicket(context.Background(), "t1")
	require.NoError(t, err)

	data, err := c.GetTicket(context.Background(), "t1")
	require.NoError(t, err)
	assert.Nil(t, data)
}

func TestInvalidateList_removes_key(t *testing.T) {
	c, _ := newTestRedisCache(t)

	err := c.SetList(context.Background(), []byte(`[{"id":"t1"}]`))
	require.NoError(t, err)

	err = c.InvalidateList(context.Background())
	require.NoError(t, err)

	data, err := c.GetList(context.Background())
	require.NoError(t, err)
	assert.Nil(t, data)
}

func TestSetTicket_respects_TTL(t *testing.T) {
	c, mr := newTestRedisCache(t)

	err := c.SetTicket(context.Background(), "ttl-ticket", []byte(`{"id":"ttl-ticket"}`))
	require.NoError(t, err)

	ttl := mr.TTL(ticketKey("ttl-ticket"))
	assert.Greater(t, ttl, 50*time.Second)
	assert.LessOrEqual(t, ttl, 60*time.Second)

	mr.FastForward(61 * time.Second)
	data, err := c.GetTicket(context.Background(), "ttl-ticket")
	require.NoError(t, err)
	assert.Nil(t, data)
}
