package server

import (
	"context"
	"fmt"
	"net/http"

	"github.com/labstack/echo-contrib/echoprometheus"
	"github.com/labstack/echo/v4"
	echomiddleware "github.com/labstack/echo/v4/middleware"
	"go.uber.org/zap"
)

// DependencyChecker can report readiness of a dependency.
type DependencyChecker interface {
	Ping(ctx context.Context) error
}

// Server is the Echo HTTP server exposing only health and metrics endpoints.
type Server struct {
	e   *echo.Echo
	log *zap.Logger
}

// New creates and configures the Echo server.
func New(redisChecker DependencyChecker, kafkaChecker DependencyChecker, log *zap.Logger) *Server {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	e.Use(echomiddleware.Recover())
	e.Use(echoprometheus.NewMiddleware("expiration_service"))

	e.GET("/metrics", echoprometheus.NewHandler())

	e.GET("/healthz/live", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	e.GET("/healthz/ready", func(c echo.Context) error {
		ctx := c.Request().Context()

		if redisChecker != nil {
			if err := redisChecker.Ping(ctx); err != nil {
				log.Warn("readiness check failed: redis", zap.Error(err))
				return c.JSON(http.StatusServiceUnavailable, map[string]string{
					"status": "unavailable",
					"reason": "redis unreachable",
				})
			}
		}

		if kafkaChecker != nil {
			if err := kafkaChecker.Ping(ctx); err != nil {
				log.Warn("readiness check failed: kafka", zap.Error(err))
				return c.JSON(http.StatusServiceUnavailable, map[string]string{
					"status": "unavailable",
					"reason": "kafka unreachable",
				})
			}
		}

		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	return &Server{e: e, log: log}
}

// Start begins listening on the given port. Blocks until stopped.
func (s *Server) Start(port int) error {
	addr := fmt.Sprintf(":%d", port)
	s.log.Info("expiration-service HTTP server listening", zap.String("addr", addr))
	if err := s.e.Start(addr); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("server error: %w", err)
	}
	return nil
}

// Shutdown gracefully stops the Echo server.
func (s *Server) Shutdown(ctx context.Context) error {
	return s.e.Shutdown(ctx)
}
