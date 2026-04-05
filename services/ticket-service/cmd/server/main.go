package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/acme/ticket-service/internal/cache"
	"github.com/acme/ticket-service/internal/config"
	grpcserver "github.com/acme/ticket-service/internal/grpc"
	"github.com/acme/ticket-service/internal/handler"
	"github.com/acme/ticket-service/internal/health"
	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/middleware"
	"github.com/acme/ticket-service/internal/reconciler"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/service"
	"github.com/acme/ticket-service/internal/tracing"
	"github.com/acme/ticket-service/pkg/logger"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/labstack/echo-contrib/echoprometheus"
	"github.com/labstack/echo/v4"
	echomiddleware "github.com/labstack/echo/v4/middleware"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	// Load and validate config — fail loudly if anything is missing
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: invalid configuration: %v\n", err)
		os.Exit(1)
	}

	// Initialise structured logger
	log, err := logger.New(cfg.LogLevel, "ticket-service")
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to create logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() //nolint:errcheck

	log.Info("starting ticket-service", zap.String("env", cfg.Env), zap.Int("port", cfg.Port), zap.Int("grpcPort", cfg.GrpcPort))

	// Initialise OpenTelemetry — must happen before any network I/O
	shutdownTracing := tracing.Init(context.Background(), "ticket-service", log)
	defer shutdownTracing(context.Background())

	// MongoDB repository
	mongoRepo, err := repository.NewMongoTicketRepository(context.Background(), cfg.MongoURI, cfg.MongoDB)
	if err != nil {
		log.Fatal("failed to connect to MongoDB", zap.Error(err))
	}
	defer mongoRepo.Close(context.Background()) //nolint:errcheck

	var ticketRepo repository.TicketRepository
	var redisChecker *health.RedisChecker
	var kafkaChecker *health.KafkaChecker
	if cfg.RedisURL != "" {
		redisOptions, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			log.Fatal("invalid REDIS_URL", zap.Error(err))
		}
		redisClient := redis.NewClient(redisOptions)
		defer redisClient.Close() //nolint:errcheck

		ticketCache := cache.NewRedisCache(redisClient)
		quotaManager := cache.NewRedisQuotaManager(redisClient)
		// Attach the quota manager to mongoRepo so that reservation hot-path
		// uses Redis Lua scripts; mongo stays the source of truth.
		repository.WithQuotaManager(quotaManager)(mongoRepo)
		ticketRepo = repository.NewCachingTicketRepository(mongoRepo, ticketCache, log)
		redisChecker, err = health.NewRedisChecker(cfg.RedisURL)
		if err != nil {
			log.Fatal("failed to create redis readiness checker", zap.Error(err))
		}
		defer redisChecker.Close() //nolint:errcheck
		log.Info("ticket cache enabled", zap.String("redisAddr", redisOptions.Addr))

		// Start quota reconciliation worker — corrects Redis drift vs MongoDB.
		reconcilerCtx, reconcilerCancel := context.WithCancel(context.Background())
		defer reconcilerCancel()
		rec := reconciler.New(mongoRepo, mongoRepo, quotaManager, reconciler.DefaultInterval, log)
		go rec.Start(reconcilerCtx)
	} else {
		ticketRepo = repository.NewCachingTicketRepository(mongoRepo, cache.NewNoopCache(), log)
		log.Info("REDIS_URL not set, ticket cache disabled")
	}

	// Kafka producer
	producer, err := kafka.NewProducer(cfg.KafkaBrokers, log)
	if err != nil {
		log.Fatal("failed to create Kafka producer", zap.Error(err))
	}
	defer producer.Close()
	kafkaChecker = health.NewKafkaChecker(cfg.KafkaBrokers)

	// Kafka consumer — listens to order events and keeps ticket reservation state in sync.
	// The producer is passed so the consumer can route failed messages to the DLQ.
	orderConsumer, err := kafka.NewOrderConsumer(cfg.KafkaBrokers, "ticket-service", ticketRepo, producer, log)
	if err != nil {
		log.Fatal("failed to create Kafka order consumer", zap.Error(err))
	}
	consumerCtx, consumerCancel := context.WithCancel(context.Background())
	defer consumerCancel()
	go orderConsumer.Start(consumerCtx)

	// WS3: Venue-service gRPC client for fetching seating plan assignment mode
	venueConn, err := grpc.NewClient(cfg.VenueServiceAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatal("failed to dial venue-service", zap.Error(err), zap.String("addr", cfg.VenueServiceAddr))
	}
	defer venueConn.Close() //nolint:errcheck
	venueClient := venuev1.NewVenueServiceClient(venueConn)
	log.Info("connected to venue-service", zap.String("addr", cfg.VenueServiceAddr))

	// Business logic service
	svc := service.NewTicketService(ticketRepo, producer, log, venueClient)

	// gRPC server — runs alongside HTTP in a separate goroutine
	grpcCtx, grpcCancel := context.WithCancel(context.Background())
	defer grpcCancel()
	grpcAddr := fmt.Sprintf(":%d", cfg.GrpcPort)
	grpcSrv := grpcserver.NewTicketGrpcServer(ticketRepo, log)
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
	e.Use(otelecho.Middleware("ticket-service")) // OTel trace propagation for HTTP
	e.Use(middleware.RequestLogger(log))
	e.Use(echomiddleware.RequestID())

	// Prometheus metrics
	e.Use(echoprometheus.NewMiddleware("ticket_service"))
	e.GET("/metrics", echoprometheus.NewHandler())

	// Health checks
	healthHandler := handler.NewHealthHandler(ticketRepo, redisChecker, kafkaChecker, log)
	e.GET("/healthz/live", healthHandler.Live)
	e.GET("/healthz/ready", healthHandler.Ready)

	// Ticket routes
	ticketHandler := handler.NewTicketHandler(svc, log)
	v1 := e.Group("/api/tickets")
	v1.POST("", ticketHandler.Create)
	v1.GET("", ticketHandler.List)
	v1.GET("/:id", ticketHandler.GetByID)
	v1.PUT("/:id", ticketHandler.Update)
	// CP-13: seated ticket catalog — attach/detach a venue-service seating plan
	v1.PUT("/:id/seating-plan", ticketHandler.AttachSeatingPlan)
	v1.DELETE("/:id/seating-plan", ticketHandler.DetachSeatingPlan)

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
