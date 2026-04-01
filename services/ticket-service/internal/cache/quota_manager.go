package cache

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// Key layout (hash-tag on ticketId ensures Cluster slot affinity):
//
//	ticket-service:{ticketId}:available             -> STRING int (quota - reserved - sold)
//	ticket-service:{ticketId}:user-reserved:{userId} -> STRING int (sum of active reservation quantities)
//
// Keys are persistent inventory keys by design — they are not given a TTL because
// they track live inventory state. Reconciliation workers correct drift on restart.

func availableKey(ticketID string) string {
	return fmt.Sprintf("ticket-service:{%s}:available", ticketID)
}

func userReservedKey(ticketID, userID string) string {
	return fmt.Sprintf("ticket-service:{%s}:user-reserved:%s", ticketID, userID)
}

// Sentinel errors returned by the Lua scripts.
var (
	// ErrQuotaInsufficient is returned when the requested quantity exceeds available inventory.
	ErrQuotaInsufficient = errors.New("redis quota: insufficient availability")
	// ErrUserLimitExceeded is returned when the per-user cap would be breached.
	ErrUserLimitExceeded = errors.New("redis quota: per-user limit exceeded")
	// ErrKeyNotInitialised is returned when the availability key does not exist.
	// The caller should re-seed Redis from the durable store and retry.
	ErrKeyNotInitialised = errors.New("redis quota: availability key not found — reseed required")
)

// QuotaManager defines the cluster-safe Redis operations for quota management.
// All implementations must be safe for concurrent use.
type QuotaManager interface {
	// Seed sets the availability counter for a ticket. Idempotent: if the key
	// already exists the value is only updated if force is true.
	Seed(ctx context.Context, ticketID string, available int, force bool) error

	// Reserve atomically decrements availability and increments the per-user
	// counter. Returns ErrQuotaInsufficient or ErrUserLimitExceeded on rejection.
	// Returns ErrKeyNotInitialised if the availability key is absent.
	Reserve(ctx context.Context, ticketID, userID string, quantity, maxPerUser int) error

	// Release atomically increments availability and decrements the per-user
	// counter. Idempotent: if counters are already at expected floor values the
	// operation is a no-op success.
	Release(ctx context.Context, ticketID, userID string, quantity int) error

	// Finalize decrements the per-user counter only. Availability was already
	// decremented at Reserve time and must not be restored on a sale.
	// Idempotent: if the per-user counter is already 0 it is left at 0.
	Finalize(ctx context.Context, ticketID, userID string, quantity int) error

	// Available returns the current availability counter. Returns -1 and
	// ErrKeyNotInitialised if the key is absent.
	Available(ctx context.Context, ticketID string) (int, error)
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

// reserveScript atomically:
//  1. Fails if the availability key does not exist (returns -2).
//  2. Fails with -1 if available < quantity.
//  3. Fails with -3 if userReserved + quantity > maxPerUser.
//  4. Decrements availability and increments user-reserved.
//  5. Returns remaining availability.
var reserveScript = redis.NewScript(`
local avail = redis.call('GET', KEYS[1])
if avail == false then
  return -2
end
avail = tonumber(avail)
local qty = tonumber(ARGV[1])
local maxPer = tonumber(ARGV[2])
if avail < qty then
  return -1
end
local userRes = tonumber(redis.call('GET', KEYS[2]) or 0)
if userRes == false then userRes = 0 end
if userRes + qty > maxPer then
  return -3
end
redis.call('DECRBY', KEYS[1], qty)
redis.call('INCRBY', KEYS[2], qty)
return avail - qty
`)

// releaseScript atomically increments availability and decrements user-reserved.
// Both counters are floored at 0 — they will never go negative.
var releaseScript = redis.NewScript(`
local qty = tonumber(ARGV[1])
local avail = tonumber(redis.call('GET', KEYS[1]) or 0)
if avail == false then avail = 0 end
redis.call('INCRBY', KEYS[1], qty)
local userRes = tonumber(redis.call('GET', KEYS[2]) or 0)
if userRes == false then userRes = 0 end
local newUser = userRes - qty
if newUser < 0 then newUser = 0 end
redis.call('SET', KEYS[2], newUser)
return redis.call('GET', KEYS[1])
`)

// finalizeScript decrements user-reserved only (availability was decremented at reserve time).
var finalizeScript = redis.NewScript(`
local qty = tonumber(ARGV[1])
local userRes = tonumber(redis.call('GET', KEYS[1]) or 0)
if userRes == false then userRes = 0 end
local newUser = userRes - qty
if newUser < 0 then newUser = 0 end
redis.call('SET', KEYS[1], newUser)
return newUser
`)

// RedisQuotaManager is the production Redis implementation of QuotaManager.
type RedisQuotaManager struct {
	client *redis.Client
}

// NewRedisQuotaManager creates a new RedisQuotaManager.
func NewRedisQuotaManager(client *redis.Client) *RedisQuotaManager {
	return &RedisQuotaManager{client: client}
}

// Seed sets the availability counter for a ticket.
// If force is false and the key already exists the call is a no-op.
func (m *RedisQuotaManager) Seed(ctx context.Context, ticketID string, available int, force bool) error {
	key := availableKey(ticketID)
	if force {
		return m.client.Set(ctx, key, available, 0).Err()
	}
	// SET NX — only set if the key does not already exist.
	return m.client.SetNX(ctx, key, available, 0).Err()
}

// Reserve runs the atomic reserve Lua script.
func (m *RedisQuotaManager) Reserve(ctx context.Context, ticketID, userID string, quantity, maxPerUser int) error {
	keys := []string{availableKey(ticketID), userReservedKey(ticketID, userID)}
	result, err := reserveScript.Run(ctx, m.client, keys, quantity, maxPerUser).Int()
	if err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("redis reserve script: %w", err)
	}
	switch result {
	case -2:
		return ErrKeyNotInitialised
	case -1:
		return ErrQuotaInsufficient
	case -3:
		return ErrUserLimitExceeded
	}
	return nil
}

// Release runs the atomic release Lua script.
func (m *RedisQuotaManager) Release(ctx context.Context, ticketID, userID string, quantity int) error {
	keys := []string{availableKey(ticketID), userReservedKey(ticketID, userID)}
	if err := releaseScript.Run(ctx, m.client, keys, quantity).Err(); err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("redis release script: %w", err)
	}
	return nil
}

// Finalize runs the atomic finalize Lua script (user-reserved counter only).
func (m *RedisQuotaManager) Finalize(ctx context.Context, ticketID, userID string, quantity int) error {
	keys := []string{userReservedKey(ticketID, userID)}
	if err := finalizeScript.Run(ctx, m.client, keys, quantity).Err(); err != nil && !errors.Is(err, redis.Nil) {
		return fmt.Errorf("redis finalize script: %w", err)
	}
	return nil
}

// Available returns the current availability counter for a ticket.
func (m *RedisQuotaManager) Available(ctx context.Context, ticketID string) (int, error) {
	val, err := m.client.Get(ctx, availableKey(ticketID)).Int()
	if errors.Is(err, redis.Nil) {
		return -1, ErrKeyNotInitialised
	}
	if err != nil {
		return -1, fmt.Errorf("redis get available: %w", err)
	}
	return val, nil
}
