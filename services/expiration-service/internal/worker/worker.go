package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hibiken/asynq"
	"go.uber.org/zap"

	"github.com/acme/expiration-service/internal/scheduler"
)

// ExpirationPublisher is the interface the worker uses to publish expiration events.
// Abstracting behind an interface allows unit testing without a real Kafka broker.
type ExpirationPublisher interface {
	PublishExpirationComplete(ctx context.Context, orderID string) error
}

// Handler processes order expiration tasks dequeued by asynq.
type Handler struct {
	publisher ExpirationPublisher
	log       *zap.Logger
}

// NewHandler creates a new Handler.
func NewHandler(publisher ExpirationPublisher, log *zap.Logger) *Handler {
	return &Handler{publisher: publisher, log: log}
}

// ProcessTask is called by the asynq server when a TaskTypeOrderExpiration task fires.
// It publishes an expiration.order.expiration_complete Kafka event.
func (h *Handler) ProcessTask(ctx context.Context, t *asynq.Task) error {
	if t.Type() != scheduler.TaskTypeOrderExpiration {
		return fmt.Errorf("unexpected task type: %s", t.Type())
	}

	var payload scheduler.OrderExpirationPayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal expiration payload: %w", err)
	}

	h.log.Info("processing order expiration", zap.String("orderId", payload.OrderID))

	if err := h.publisher.PublishExpirationComplete(ctx, payload.OrderID); err != nil {
		return fmt.Errorf("publish expiration complete for order %s: %w", payload.OrderID, err)
	}

	h.log.Info("order expiration published", zap.String("orderId", payload.OrderID))
	return nil
}

// Server wraps an asynq.Server and registers the order expiration handler.
type Server struct {
	srv     *asynq.Server
	handler *Handler
}

// NewServer creates and returns an asynq Server configured to process expiration tasks.
func NewServer(redisAddr string, handler *Handler, log *zap.Logger) *Server {
	srv := asynq.NewServer(
		asynq.RedisClientOpt{Addr: redisAddr},
		asynq.Config{
			Concurrency: 10,
			ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, t *asynq.Task, err error) {
				log.Error("asynq task failed",
					zap.String("taskType", t.Type()),
					zap.Error(err),
				)
			}),
		},
	)

	return &Server{srv: srv, handler: handler}
}

// Start registers the task handler and starts the asynq worker. Blocks until the
// server is stopped.
func (s *Server) Start() error {
	mux := asynq.NewServeMux()
	mux.HandleFunc(scheduler.TaskTypeOrderExpiration, s.handler.ProcessTask)

	if err := s.srv.Start(mux); err != nil {
		return fmt.Errorf("start asynq server: %w", err)
	}
	return nil
}

// Shutdown gracefully stops the asynq server.
func (s *Server) Shutdown() {
	s.srv.Shutdown()
}
