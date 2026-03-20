package middleware

import (
	"time"

	"github.com/labstack/echo/v4"
	"go.uber.org/zap"
)

// RequestLogger returns an Echo middleware that logs every request as structured JSON.
func RequestLogger(log *zap.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()

			err := next(c)

			req := c.Request()
			res := c.Response()

			log.Info("request",
				zap.String("method", req.Method),
				zap.String("path", req.URL.Path),
				zap.Int("status", res.Status),
				zap.Duration("latency", time.Since(start)),
				zap.String("requestId", res.Header().Get(echo.HeaderXRequestID)),
				zap.String("traceId", req.Header.Get("traceparent")),
			)

			return err
		}
	}
}
