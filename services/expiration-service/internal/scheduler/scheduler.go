package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	appkafka "github.com/acme/expiration-service/internal/kafka"
	"github.com/hibiken/asynq"
	"go.uber.org/zap"
)

// TaskTypeOrderExpiration is the asynq task type for order expiration jobs.
const TaskTypeOrderExpiration = "order:expire"

// OrderExpirationPayload is the payload stored in each asynq task.
type OrderExpirationPayload struct {
	OrderID      string            `json:"orderId"`
	TraceHeaders map[string]string `json:"traceHeaders,omitempty"`
}

// Scheduler schedules delayed order expiration tasks via asynq.
type Scheduler struct {
	client *asynq.Client
	log    *zap.Logger
}

// New creates a new Scheduler backed by Redis at the given address.
func New(redisAddr string, log *zap.Logger) *Scheduler {
	client := asynq.NewClient(asynq.RedisClientOpt{Addr: redisAddr})
	return &Scheduler{client: client, log: log}
}

// ScheduleExpiration enqueues an order expiration task to fire at expiresAt.
// The task ID is set to the orderID to ensure idempotency — re-enqueueing the same
// order will be a no-op if the task is already pending or scheduled.
func (s *Scheduler) ScheduleExpiration(ctx context.Context, orderID string, expiresAt time.Time) error {
	payload, err := json.Marshal(OrderExpirationPayload{
		OrderID:      orderID,
		TraceHeaders: appkafka.CaptureTraceHeaders(ctx),
	})
	if err != nil {
		return fmt.Errorf("marshal expiration payload: %w", err)
	}

	delay := time.Until(expiresAt)
	if delay < 0 {
		// Order is already expired — process immediately.
		delay = 0
	}

	task := asynq.NewTask(TaskTypeOrderExpiration, payload,
		asynq.TaskID(orderID),  // Unique task ID — prevents duplicate scheduling.
		asynq.ProcessIn(delay), // Delay until expiresAt.
		asynq.MaxRetry(3),
		asynq.Retention(24*time.Hour),
	)

	info, err := s.client.EnqueueContext(ctx, task)
	if err != nil {
		// ErrTaskIDConflict means an identical task is already scheduled — idempotent, not an error.
		if isTaskIDConflict(err) {
			s.log.Info("expiration task already scheduled, skipping",
				zap.String("orderId", orderID),
			)
			return nil
		}
		return fmt.Errorf("enqueue expiration task: %w", err)
	}

	s.log.Info("expiration task scheduled",
		zap.String("orderId", orderID),
		zap.String("taskId", info.ID),
		zap.Duration("delay", delay),
		zap.Time("expiresAt", expiresAt),
	)
	return nil
}

// Close closes the underlying asynq client.
func (s *Scheduler) Close() error {
	return s.client.Close()
}

// isTaskIDConflict returns true when asynq reports a task ID conflict (duplicate).
func isTaskIDConflict(err error) bool {
	return errors.Is(err, asynq.ErrTaskIDConflict)
}
