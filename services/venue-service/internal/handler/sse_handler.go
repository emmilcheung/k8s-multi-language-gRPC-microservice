package handler

import (
	"net/http"

	"github.com/acme/venue-service/internal/sse"
	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// SSEPublisher is the narrow interface SSEHandler needs from the broadcaster.
type SSEPublisher interface {
	Subscribe(planID string) *sse.Client
	Unsubscribe(c *sse.Client)
}

// SSEHandler handles GET /api/seating-plans/:planId/events (text/event-stream).
type SSEHandler struct {
	broadcaster SSEPublisher
	log         *zap.Logger
}

// NewSSEHandler creates a new SSEHandler.
func NewSSEHandler(broadcaster SSEPublisher, log *zap.Logger) *SSEHandler {
	return &SSEHandler{broadcaster: broadcaster, log: log}
}

// RegisterRoutes attaches the SSE route to the given plan group.
// Expects to be registered under /api/seating-plans/:planId.
func (h *SSEHandler) RegisterRoutes(g *echo.Group) {
	g.GET("/events", h.Stream)
}

// Stream handles GET /api/seating-plans/:planId/events.
//
// The response is an infinite text/event-stream. The client receives:
//   - data frames for each seat state change (JSON payload from hold manager).
//   - heartbeat frames every ~15 s (": heartbeat\n\n") to prevent proxy timeouts.
//
// On client disconnect (ctx.Done) the handler cleans up the subscription and returns.
func (h *SSEHandler) Stream(c echo.Context) error {
	planID := c.Param("planId")
	if planID == "" {
		return c.JSON(http.StatusBadRequest, errorResponse("planId is required"))
	}

	w := c.Response()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.Writer.(http.Flusher)
	if !ok {
		h.log.Error("SSE: response writer does not implement http.Flusher",
			zap.String("planId", planID))
		return nil
	}

	client := h.broadcaster.Subscribe(planID)
	defer h.broadcaster.Unsubscribe(client)

	h.log.Info("SSE client connected", zap.String("planId", planID))

	// Send an initial snapshot comment so the client knows it's connected.
	if _, writeErr := w.Write([]byte(": connected\n\n")); writeErr == nil {
		flusher.Flush()
	}

	ctx := c.Request().Context()
	for {
		select {
		case <-ctx.Done():
			h.log.Info("SSE client disconnected", zap.String("planId", planID))
			return nil
		case msg, open := <-client.MsgChan:
			if !open {
				return nil
			}
			if _, writeErr := w.Write([]byte(msg)); writeErr != nil {
				h.log.Warn("SSE write error",
					zap.String("planId", planID), zap.Error(writeErr))
				return nil
			}
			flusher.Flush()
		case <-c.Request().Context().Done():
			return nil
		}
	}
}
