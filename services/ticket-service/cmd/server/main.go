package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/acme/ticket-service/internal/config"
	grpcserver "github.com/acme/ticket-service/internal/grpc"
	"github.com/acme/ticket-service/internal/handler"
	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/middleware"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	"github.com/acme/ticket-service/pkg/logger"
	"github.com/labstack/echo-contrib/echoprometheus"
	"github.com/labstack/echo/v4"
	echomiddleware "github.com/labstack/echo/v4/middleware"
	"go.uber.org/zap"
)

func main() {
	// Load and validate config — fail loudly if anything is missing
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: invalid configuration: %v\n", err)
		os.Exit(1)
	}

	// Initialise structured logger
	log, err := logger.New(cfg.LogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to create logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() //nolint:errcheck

	log.Info("starting ticket-service", zap.String("env", cfg.Env), zap.Int("port", cfg.Port), zap.Int("grpcPort", cfg.GrpcPort))

	// MongoDB repository
	repo, err := repository.NewMongoTicketRepository(context.Background(), cfg.MongoURI, cfg.MongoDB)
	if err != nil {
		log.Fatal("failed to connect to MongoDB", zap.Error(err))
	}
	defer repo.Close(context.Background()) //nolint:errcheck

	// Kafka producer
	producer, err := kafka.NewProducer(cfg.KafkaBrokers, log)
	if err != nil {
		log.Fatal("failed to create Kafka producer", zap.Error(err))
	}
	defer producer.Close()

	// Kafka consumer — listens to order events and keeps ticket reservation state in sync
	orderConsumer, err := kafka.NewOrderConsumer(cfg.KafkaBrokers, "ticket-service", repo, log)
	if err != nil {
		log.Fatal("failed to create Kafka order consumer", zap.Error(err))
	}
	consumerCtx, consumerCancel := context.WithCancel(context.Background())
	defer consumerCancel()
	go orderConsumer.Start(consumerCtx)

	// Business logic service
	svc := service.NewTicketService(repo, producer, log)

	// gRPC server — runs alongside HTTP in a separate goroutine
	grpcCtx, grpcCancel := context.WithCancel(context.Background())
	defer grpcCancel()
	grpcAddr := fmt.Sprintf(":%d", cfg.GrpcPort)
	grpcSrv := grpcserver.NewTicketGrpcServer(repo, log)
	go func() {
		if err := grpcserver.Start(grpcCtx, grpcAddr, grpcSrv, log); err != nil {
			log.Fatal("gRPC server error", zap.Error(err))
		}
	}()

	// Echo HTTP server
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	// Global middleware
	e.Use(echomiddleware.Recover())
	e.Use(middleware.RequestLogger(log))
	e.Use(echomiddleware.RequestID())

	// Prometheus metrics
	e.Use(echoprometheus.NewMiddleware("ticket_service"))
	e.GET("/metrics", echoprometheus.NewHandler())

	// Health checks
	healthHandler := handler.NewHealthHandler(repo, log)
	e.GET("/healthz/live", healthHandler.Live)
	e.GET("/healthz/ready", healthHandler.Ready)

	// Ticket routes
	ticketHandler := handler.NewTicketHandler(svc, log)
	v1 := e.Group("/api/tickets")
	v1.POST("", ticketHandler.Create)
	v1.GET("", ticketHandler.List)
	v1.GET("/:id", ticketHandler.GetByID)
	v1.PUT("/:id", ticketHandler.Update)

	// Graceful shutdown
	addr := fmt.Sprintf(":%d", cfg.Port)
	go func() {
		log.Info("ticket-service listening", zap.String("addr", addr))
		if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
			log.Fatal("server error", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info("shutting down ticket-service")
	grpcCancel() // signal gRPC server to stop
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := e.Shutdown(ctx); err != nil {
		log.Error("shutdown error", zap.Error(err))
	}
}
