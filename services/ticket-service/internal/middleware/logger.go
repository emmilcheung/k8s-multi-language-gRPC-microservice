package middleware

import (
	"time"

	"github.com/labstack/echo/v4"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
)

// RequestLogger returns an Echo middleware that logs every request as structured JSON.
// It injects the OTel traceId and spanId from the active span into each log line (O-02).
func RequestLogger(log *zap.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()

			err := next(c)

			req := c.Request()
			res := c.Response()

			// Extract traceId / spanId from the OTel span on the request context.
			// otelecho middleware (registered before RequestLogger) populates the span.
			spanCtx := trace.SpanFromContext(req.Context()).SpanContext()
			fields := []zap.Field{
				zap.String("method", req.Method),
				zap.String("path", req.URL.Path),
				zap.Int("status", res.Status),
				zap.Duration("latency", time.Since(start)),
				zap.String("requestId", res.Header().Get(echo.HeaderXRequestID)),
			}
			if spanCtx.IsValid() {
				fields = append(fields,
					zap.String("traceId", spanCtx.TraceID().String()),
					zap.String("spanId", spanCtx.SpanID().String()),
				)
			}

			log.Info("request", fields...)

			return err
		}
	}
}
