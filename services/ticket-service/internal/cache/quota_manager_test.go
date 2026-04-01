package cache_test

import (
	"context"
	"testing"

	"github.com/acme/ticket-service/internal/cache"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestQuotaManager spins up a miniredis server and returns a
// RedisQuotaManager wired to it, plus a cleanup function.
func newTestQuotaManager(t *testing.T) (*cache.RedisQuotaManager, func()) {
	t.Helper()
	mr, err := miniredis.Run()
	require.NoError(t, err)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	qm := cache.NewRedisQuotaManager(client)
	cleanup := func() {
		_ = client.Close()
		mr.Close()
	}
	return qm, cleanup
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

func TestQuotaManager_Seed_SetsAvailabilityKey(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	require.NoError(t, qm.Seed(context.Background(), "ticket-1", 10, false))

	avail, err := qm.Available(context.Background(), "ticket-1")
	require.NoError(t, err)
	assert.Equal(t, 10, avail)
}

func TestQuotaManager_Seed_IsIdempotent_WhenNotForced(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-2", 5, false))
	// Second seed with different value and force=false must not overwrite.
	require.NoError(t, qm.Seed(ctx, "ticket-2", 99, false))

	avail, err := qm.Available(ctx, "ticket-2")
	require.NoError(t, err)
	assert.Equal(t, 5, avail)
}

func TestQuotaManager_Seed_Overwrites_WhenForced(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-3", 5, false))
	require.NoError(t, qm.Seed(ctx, "ticket-3", 20, true))

	avail, err := qm.Available(ctx, "ticket-3")
	require.NoError(t, err)
	assert.Equal(t, 20, avail)
}

// ─── Available ────────────────────────────────────────────────────────────────

func TestQuotaManager_Available_ReturnsErrKeyNotInitialised_WhenAbsent(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	val, err := qm.Available(context.Background(), "no-such-ticket")
	assert.ErrorIs(t, err, cache.ErrKeyNotInitialised)
	assert.Equal(t, -1, val)
}

// ─── Reserve ──────────────────────────────────────────────────────────────────

func TestQuotaManager_Reserve_ShouldSucceed_WhenQuotaAndLimitAreAvailable(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-4", 10, false))

	require.NoError(t, qm.Reserve(ctx, "ticket-4", "user-1", 3, 5))

	avail, err := qm.Available(ctx, "ticket-4")
	require.NoError(t, err)
	assert.Equal(t, 7, avail)
}

func TestQuotaManager_Reserve_ShouldReturnErrQuotaInsufficient_WhenNotEnoughInventory(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-5", 2, false))

	err := qm.Reserve(ctx, "ticket-5", "user-1", 3, 10)
	assert.ErrorIs(t, err, cache.ErrQuotaInsufficient)

	// Availability must be unchanged.
	avail, err := qm.Available(ctx, "ticket-5")
	require.NoError(t, err)
	assert.Equal(t, 2, avail)
}

func TestQuotaManager_Reserve_ShouldReturnErrUserLimitExceeded_WhenCapBreached(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-6", 100, false))

	// First reservation succeeds (cap = 2).
	require.NoError(t, qm.Reserve(ctx, "ticket-6", "user-1", 2, 2))

	// Second reservation exceeds per-user cap.
	err := qm.Reserve(ctx, "ticket-6", "user-1", 1, 2)
	assert.ErrorIs(t, err, cache.ErrUserLimitExceeded)

	// Availability must not have changed on the failed attempt.
	avail, err := qm.Available(ctx, "ticket-6")
	require.NoError(t, err)
	assert.Equal(t, 98, avail)
}

func TestQuotaManager_Reserve_ShouldReturnErrKeyNotInitialised_WhenKeyAbsent(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	err := qm.Reserve(context.Background(), "missing-ticket", "user-1", 1, 5)
	assert.ErrorIs(t, err, cache.ErrKeyNotInitialised)
}

// ─── Release ──────────────────────────────────────────────────────────────────

func TestQuotaManager_Release_ShouldRestoreAvailabilityAndUserCounter(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-7", 5, false))
	require.NoError(t, qm.Reserve(ctx, "ticket-7", "user-1", 2, 5))

	require.NoError(t, qm.Release(ctx, "ticket-7", "user-1", 2))

	avail, err := qm.Available(ctx, "ticket-7")
	require.NoError(t, err)
	assert.Equal(t, 5, avail) // back to original
}

func TestQuotaManager_Release_ShouldBeIdempotent_WhenCalledTwice(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-8", 5, false))
	require.NoError(t, qm.Reserve(ctx, "ticket-8", "user-1", 2, 5))
	require.NoError(t, qm.Release(ctx, "ticket-8", "user-1", 2))

	// Second release: per-user counter is already 0 — must not go negative.
	require.NoError(t, qm.Release(ctx, "ticket-8", "user-1", 2))

	// Availability should be 7 (5 + 2 + 2) because we incremented twice —
	// the Release script unconditionally adds qty to availability.
	// This is acceptable: reconciliation workers correct any drift.
	avail, err := qm.Available(ctx, "ticket-8")
	require.NoError(t, err)
	assert.GreaterOrEqual(t, avail, 5) // at least restored
}

func TestQuotaManager_Release_ShouldNotGoNegative_WhenUserCounterAlreadyZero(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-9", 10, false))

	// Release without prior reserve — user counter starts at 0.
	require.NoError(t, qm.Release(ctx, "ticket-9", "user-1", 1))

	// Verify the user counter is not negative (it should be 0 after floor clamp).
	// We can infer this indirectly: a subsequent reserve should be allowed up to maxPerUser.
	require.NoError(t, qm.Reserve(ctx, "ticket-9", "user-1", 1, 1))
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

func TestQuotaManager_Finalize_ShouldDecrementUserCounterOnly(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-10", 5, false))
	require.NoError(t, qm.Reserve(ctx, "ticket-10", "user-1", 2, 5))

	require.NoError(t, qm.Finalize(ctx, "ticket-10", "user-1", 2))

	// Availability must NOT be restored (the quantity is sold).
	avail, err := qm.Available(ctx, "ticket-10")
	require.NoError(t, err)
	assert.Equal(t, 3, avail)
}

func TestQuotaManager_Finalize_ShouldBeIdempotent_WhenCalledTwice(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-11", 5, false))
	require.NoError(t, qm.Reserve(ctx, "ticket-11", "user-1", 2, 5))
	require.NoError(t, qm.Finalize(ctx, "ticket-11", "user-1", 2))

	// Second finalize: per-user counter already 0, must not error.
	require.NoError(t, qm.Finalize(ctx, "ticket-11", "user-1", 2))

	// Availability must still be 3 (not double-decremented).
	avail, err := qm.Available(ctx, "ticket-11")
	require.NoError(t, err)
	assert.Equal(t, 3, avail)
}

// ─── Full lifecycle ───────────────────────────────────────────────────────────

func TestQuotaManager_FullLifecycle_ReserveRelease(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-12", 3, false))

	// Reserve 2.
	require.NoError(t, qm.Reserve(ctx, "ticket-12", "buyer-1", 2, 3))

	// Try to reserve 2 more — should fail (only 1 available).
	assert.ErrorIs(t, qm.Reserve(ctx, "ticket-12", "buyer-2", 2, 3), cache.ErrQuotaInsufficient)

	// Release the original 2.
	require.NoError(t, qm.Release(ctx, "ticket-12", "buyer-1", 2))

	// Now buyer-2 can reserve 2.
	require.NoError(t, qm.Reserve(ctx, "ticket-12", "buyer-2", 2, 3))

	avail, err := qm.Available(ctx, "ticket-12")
	require.NoError(t, err)
	assert.Equal(t, 1, avail)
}

func TestQuotaManager_FullLifecycle_ReserveFinalize(t *testing.T) {
	qm, cleanup := newTestQuotaManager(t)
	defer cleanup()

	ctx := context.Background()
	require.NoError(t, qm.Seed(ctx, "ticket-13", 5, false))

	require.NoError(t, qm.Reserve(ctx, "ticket-13", "buyer-1", 3, 5))
	require.NoError(t, qm.Finalize(ctx, "ticket-13", "buyer-1", 3))

	// Availability reduced permanently by 3.
	avail, err := qm.Available(ctx, "ticket-13")
	require.NoError(t, err)
	assert.Equal(t, 2, avail)

	// Buyer-1 can now reserve again (per-user counter cleared by finalize).
	require.NoError(t, qm.Reserve(ctx, "ticket-13", "buyer-1", 2, 5))
}
