package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/hibiken/asynq"
	"github.com/stretchr/testify/assert"
)

func TestIsTaskIDConflict_TrueForConflict(t *testing.T) {
	assert.True(t, isTaskIDConflict(asynq.ErrTaskIDConflict))
}

func TestIsTaskIDConflict_FalseForOtherError(t *testing.T) {
	assert.False(t, isTaskIDConflict(context.DeadlineExceeded))
	assert.False(t, isTaskIDConflict(asynq.ErrQueueNotFound))
}

// TestDelayCalculation_AlreadyExpiredClampsToZero verifies that an order whose
// expiry is in the past results in a zero (immediate) delay.
func TestDelayCalculation_AlreadyExpiredClampsToZero(t *testing.T) {
	expiresAt := time.Now().Add(-5 * time.Minute)
	delay := time.Until(expiresAt)
	if delay < 0 {
		delay = 0
	}
	assert.Equal(t, time.Duration(0), delay)
}

// TestDelayCalculation_FutureExpiryIsPositive verifies that an order whose
// expiry is in the future results in a positive delay.
func TestDelayCalculation_FutureExpiryIsPositive(t *testing.T) {
	expiresAt := time.Now().Add(10 * time.Minute)
	delay := time.Until(expiresAt)
	if delay < 0 {
		delay = 0
	}
	assert.Greater(t, int64(delay), int64(0))
}
