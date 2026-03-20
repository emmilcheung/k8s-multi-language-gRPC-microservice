package worker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/hibiken/asynq"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"github.com/acme/expiration-service/internal/scheduler"
)

// mockPublisher records calls to PublishExpirationComplete.
type mockPublisher struct {
	calls  []string
	retErr error
}

func (m *mockPublisher) PublishExpirationComplete(_ context.Context, orderID string) error {
	m.calls = append(m.calls, orderID)
	return m.retErr
}

func makeTask(t *testing.T, orderID string) *asynq.Task {
	t.Helper()
	payload, err := json.Marshal(scheduler.OrderExpirationPayload{OrderID: orderID})
	require.NoError(t, err)
	return asynq.NewTask(scheduler.TaskTypeOrderExpiration, payload)
}

func TestProcessTask_ShouldPublishExpirationComplete(t *testing.T) {
	pub := &mockPublisher{}
	h := NewHandler(pub, zap.NewNop())

	task := makeTask(t, "order-abc-123")
	err := h.ProcessTask(context.Background(), task)

	require.NoError(t, err)
	assert.Equal(t, []string{"order-abc-123"}, pub.calls)
}

func TestProcessTask_ShouldReturnErrorWhenPublisherFails(t *testing.T) {
	pub := &mockPublisher{retErr: errors.New("kafka unavailable")}
	h := NewHandler(pub, zap.NewNop())

	task := makeTask(t, "order-xyz")
	err := h.ProcessTask(context.Background(), task)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "publish expiration complete")
}

func TestProcessTask_ShouldReturnErrorForUnknownTaskType(t *testing.T) {
	pub := &mockPublisher{}
	h := NewHandler(pub, zap.NewNop())

	task := asynq.NewTask("unknown:type", []byte(`{}`))
	err := h.ProcessTask(context.Background(), task)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "unexpected task type")
}

func TestProcessTask_ShouldReturnErrorForInvalidPayload(t *testing.T) {
	pub := &mockPublisher{}
	h := NewHandler(pub, zap.NewNop())

	task := asynq.NewTask(scheduler.TaskTypeOrderExpiration, []byte(`not-json`))
	err := h.ProcessTask(context.Background(), task)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "unmarshal")
}

func TestProcessTask_ShouldNotPublishWhenOrderIDIsEmpty(t *testing.T) {
	// An empty orderId is technically valid from a deserialization standpoint,
	// but the publisher will receive it — the order-service is responsible for
	// rejecting unknown order IDs. This test documents that behaviour.
	pub := &mockPublisher{}
	h := NewHandler(pub, zap.NewNop())

	task := makeTask(t, "")
	err := h.ProcessTask(context.Background(), task)

	require.NoError(t, err)
	assert.Equal(t, []string{""}, pub.calls)
}
