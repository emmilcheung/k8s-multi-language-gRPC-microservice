package hold

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

// The change counter is the cursor an SSE client resumes from. If it ever
// repeats or goes backwards, a client cannot tell an event it already applied
// from one it has not — which for seat availability means showing a seat as
// free after it was taken.

func newVersionTestManager() *Manager {
	// nil Redis exercises the in-process counter; the repositories are never
	// reached by the version path.
	return NewManager(nil, nil, nil, 0, zap.NewNop())
}

func TestVersions_AreMonotonicPerPlan(t *testing.T) {
	m := newVersionTestManager()
	ctx := context.Background()

	assert.Equal(t, uint64(0), m.currentVersion(ctx, "plan-1"),
		"a plan nobody has changed starts at 0, which is the cursor a first-time client holds")

	for want := uint64(1); want <= 3; want++ {
		assert.Equal(t, want, m.nextVersion(ctx, "plan-1"))
		assert.Equal(t, want, m.currentVersion(ctx, "plan-1"),
			"reading the cursor must not advance it")
	}
}

func TestVersions_AreIndependentAcrossPlans(t *testing.T) {
	m := newVersionTestManager()
	ctx := context.Background()

	// Two on-sales run at once. A shared counter would make every change to one
	// plan look like a gap to every client watching the other.
	require.Equal(t, uint64(1), m.nextVersion(ctx, "plan-1"))
	require.Equal(t, uint64(1), m.nextVersion(ctx, "plan-2"))
	require.Equal(t, uint64(2), m.nextVersion(ctx, "plan-1"))

	assert.Equal(t, uint64(2), m.currentVersion(ctx, "plan-1"))
	assert.Equal(t, uint64(1), m.currentVersion(ctx, "plan-2"))
}

func TestVersions_AreUniqueUnderConcurrentChanges(t *testing.T) {
	// Holds and releases for one plan are handled concurrently, so the counter
	// is contended by definition. Two changes sharing a version would make one
	// of them invisible to a resyncing client.
	const goroutines = 50
	m := newVersionTestManager()
	ctx := context.Background()

	var mu sync.Mutex
	seen := make(map[uint64]struct{}, goroutines)

	var wg sync.WaitGroup
	for range goroutines {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v := m.nextVersion(ctx, "plan-1")
			mu.Lock()
			seen[v] = struct{}{}
			mu.Unlock()
		}()
	}
	wg.Wait()

	assert.Len(t, seen, goroutines, "every change must get its own version")
	assert.Equal(t, uint64(goroutines), m.currentVersion(ctx, "plan-1"))
}
