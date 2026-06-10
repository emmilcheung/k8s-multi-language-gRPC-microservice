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

func newSWR(t *testing.T) (*RedisSWRCache, *miniredis.Miniredis) {
	mr, err := miniredis.Run()
	require.NoError(t, err)
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return NewRedisSWRCache(client), mr
}

func TestRedisSWRCache_SetThenGet_FreshNotStale(t *testing.T) {
	c, _ := newSWR(t)
	require.NoError(t, c.SetTicket(context.Background(), "t1", []byte(`{"id":"t1"}`)))

	data, stale, err := c.GetTicketSWR(context.Background(), "t1")
	require.NoError(t, err)
	assert.Equal(t, []byte(`{"id":"t1"}`), data)
	assert.False(t, stale, "entry within soft TTL must not be stale")
}

func TestRedisSWRCache_PastSoftTTL_IsStaleButServeable(t *testing.T) {
	c, _ := newSWR(t)
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	require.NoError(t, c.SetTicket(context.Background(), "t1", []byte(`{"id":"t1"}`)))

	now = now.Add(ticketSoftTTL + time.Second) // past soft, within hard
	data, stale, err := c.GetTicketSWR(context.Background(), "t1")
	require.NoError(t, err)
	assert.Equal(t, []byte(`{"id":"t1"}`), data, "stale entry must still be served")
	assert.True(t, stale)
}

func TestRedisSWRCache_PastHardTTL_Absent(t *testing.T) {
	c, mr := newSWR(t)
	require.NoError(t, c.SetTicket(context.Background(), "t1", []byte(`{"id":"t1"}`)))

	mr.FastForward(ticketHardTTL + time.Second)
	data, stale, err := c.GetTicketSWR(context.Background(), "t1")
	require.NoError(t, err)
	assert.Nil(t, data, "entry past hard TTL must be absent")
	assert.False(t, stale)
}

func TestRedisSWRCache_TryRefresh_OnlyOneWinner(t *testing.T) {
	c, _ := newSWR(t)
	first, err := c.TryRefreshTicket(context.Background(), "t1")
	require.NoError(t, err)
	assert.NotEmpty(t, first, "first caller acquires the refresh lock and gets a token")

	second, err := c.TryRefreshTicket(context.Background(), "t1")
	require.NoError(t, err)
	assert.Empty(t, second, "second caller must not acquire the lock while held")
}

func TestRedisSWRCache_ReleaseRefresh_AllowsImmediateReacquire(t *testing.T) {
	c, _ := newSWR(t)
	token, err := c.TryRefreshTicket(context.Background(), "t1")
	require.NoError(t, err)
	require.NotEmpty(t, token)

	require.NoError(t, c.ReleaseRefreshTicket(context.Background(), "t1", token))

	again, err := c.TryRefreshTicket(context.Background(), "t1")
	require.NoError(t, err)
	assert.NotEmpty(t, again, "released lock must be immediately re-acquirable")
}

func TestRedisSWRCache_ReleaseRefresh_WrongTokenDoesNotUnlock(t *testing.T) {
	c, _ := newSWR(t)
	token, err := c.TryRefreshTicket(context.Background(), "t1")
	require.NoError(t, err)
	require.NotEmpty(t, token)

	// A stale/foreign token must never delete the current holder's lock.
	require.NoError(t, c.ReleaseRefreshTicket(context.Background(), "t1", "not-the-token"))

	second, err := c.TryRefreshTicket(context.Background(), "t1")
	require.NoError(t, err)
	assert.Empty(t, second, "lock must still be held after a wrong-token release")
}

func TestRedisSWRCache_InvalidateRemovesEntry(t *testing.T) {
	c, _ := newSWR(t)
	require.NoError(t, c.SetTicket(context.Background(), "t1", []byte(`{"id":"t1"}`)))
	require.NoError(t, c.InvalidateTicket(context.Background(), "t1"))

	data, _, err := c.GetTicketSWR(context.Background(), "t1")
	require.NoError(t, err)
	assert.Nil(t, data)
}
