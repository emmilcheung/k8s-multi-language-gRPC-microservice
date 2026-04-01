package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/acme/venue-service/internal/config"
	grpcserver "github.com/acme/venue-service/internal/grpc"
	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/health"
	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/kafka"
	"github.com/acme/venue-service/internal/middleware"
	"github.com/acme/venue-service/internal/migrations"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/acme/venue-service/internal/service"
	"github.com/acme/venue-service/internal/tracing"
	"github.com/acme/venue-service/pkg/logger"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo-contrib/echoprometheus"
	"github.com/labstack/echo/v4"
	echomiddleware "github.com/labstack/echo/v4/middleware"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	"go.uber.org/zap"
)

func main() {
	// Load and validate config — fail loudly if anything is missing.
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: invalid configuration: %v\n", err)
		os.Exit(1)
	}

	// Initialise structured logger.
	log, err := logger.New(cfg.LogLevel, "venue-service")
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to create logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() //nolint:errcheck

	log.Info("starting venue-service",
		zap.String("env", cfg.Env),
		zap.Int("port", cfg.Port),
		zap.Int("grpcPort", cfg.GrpcPort),
	)

	// Initialise OpenTelemetry — must happen before any network I/O.
	shutdownTracing := tracing.Init(context.Background(), "venue-service", log)
	defer shutdownTracing(context.Background())

	// Run database migrations before accepting connections.
	if err := migrations.Run(cfg.DatabaseURL, log); err != nil {
		log.Fatal("database migration failed", zap.Error(err))
	}

	// PostgreSQL connection pool.
	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Fatal("failed to create postgres pool", zap.Error(err))
	}
	defer pool.Close()

	if err := pool.Ping(context.Background()); err != nil {
		log.Fatal("postgres ping failed", zap.Error(err))
	}
	log.Info("postgres connected")

	// Health checkers.
	dbChecker := health.NewDBChecker(pool)
	kafkaChecker := health.NewKafkaChecker(cfg.KafkaBrokers)

	var redisChecker *health.RedisChecker
	var redisClient *redis.Client

	if cfg.RedisURL != "" {
		opts, parseErr := redis.ParseURL(cfg.RedisURL)
		if parseErr != nil {
			log.Fatal("invalid REDIS_URL", zap.Error(parseErr))
		}
		redisClient = redis.NewClient(opts)
		defer redisClient.Close() //nolint:errcheck

		if pingErr := redisClient.Ping(context.Background()).Err(); pingErr != nil {
			log.Fatal("redis ping failed", zap.Error(pingErr))
		}
		log.Info("redis connected", zap.String("addr", opts.Addr))

		var checkerErr error
		redisChecker, checkerErr = health.NewRedisChecker(cfg.RedisURL)
		if checkerErr != nil {
			log.Fatal("failed to create redis health checker", zap.Error(checkerErr))
		}
		defer redisChecker.Close() //nolint:errcheck
	} else {
		log.Info("REDIS_URL not set, Redis disabled")
	}

	// Kafka producer.
	producer, err := kafka.NewProducer(cfg.KafkaBrokers, log)
	if err != nil {
		log.Fatal("failed to create Kafka producer", zap.Error(err))
	}
	defer producer.Close()

	// Repositories — wired in CP-08.
	venueRepo := pgrepo.NewVenueRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	priceTierRepo := pgrepo.NewPriceTierRepo(pool)
	reservationRepo := pgrepo.NewReservationRepo(pool)

	// Business logic service (implements OrderEventHandler for Kafka consumer).
	svc := service.NewVenueService(reservationRepo, sectionRepo, log)

	// Hold manager — Redis hot path + PostgreSQL fallback.
	holdMgr := hold.NewManager(redisClient, sectionRepo, planRepo, log)

	// Hold sweeper — releases expired holds every 30 seconds.
	sweeper := hold.NewSweeper(holdMgr, 30*time.Second, log)
	sweeperCtx, sweeperCancel := context.WithCancel(context.Background())
	defer sweeperCancel()
	go sweeper.Start(sweeperCtx)

	// Kafka consumer — listens to order lifecycle events.
	orderConsumer, err := kafka.NewOrderConsumer(cfg.KafkaBrokers, "venue-service", svc, log)
	if err != nil {
		log.Fatal("failed to create Kafka order consumer", zap.Error(err))
	}
	consumerCtx, consumerCancel := context.WithCancel(context.Background())
	defer consumerCancel()
	go orderConsumer.Start(consumerCtx)

	// gRPC server — wired with real repos in CP-08.
	grpcSrv := grpcserver.NewVenueGrpcServer(reservationRepo, sectionRepo, planRepo, log)
	grpcCtx, grpcCancel := context.WithCancel(context.Background())
	defer grpcCancel()
	grpcAddr := fmt.Sprintf(":%d", cfg.GrpcPort)
	go func() {
		if grpcErr := grpcserver.Start(grpcCtx, grpcAddr, grpcSrv, log); grpcErr != nil {
			log.Fatal("gRPC server error", zap.Error(grpcErr))
		}
	}()

	// Echo HTTP server.
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	// Global middleware.
	e.Use(echomiddleware.Recover())
	e.Use(otelecho.Middleware("venue-service"))
	e.Use(middleware.RequestLogger(log))
	e.Use(echomiddleware.RequestID())

	// Prometheus metrics.
	e.Use(echoprometheus.NewMiddleware("venue_service"))
	e.GET("/metrics", echoprometheus.NewHandler())

	// Health checks.
	healthHandler := handler.NewHealthHandler(dbChecker, redisChecker, kafkaChecker, log)
	e.GET("/healthz/live", healthHandler.Live)
	e.GET("/healthz/ready", healthHandler.Ready)

	// API routes.
	api := e.Group("/api")

	venueHandler := handler.NewVenueHandler(venueRepo, log)
	venueHandler.RegisterRoutes(api.Group("/venues"))

	planHandler := handler.NewPlanHandler(planRepo, log)
	planHandler.RegisterRoutes(api.Group("/seating-plans"))

	sectionHandler := handler.NewSectionHandler(planRepo, sectionRepo, priceTierRepo, log)
	sectionHandler.RegisterRoutes(api.Group("/seating-plans/:planId"))

	seatHoldHandler := handler.NewSeatHoldHandler(holdMgr, log)
	seatHoldHandler.RegisterRoutes(api.Group("/seating-plans/:planId"))

	// Graceful shutdown.
	addr := fmt.Sprintf(":%d", cfg.Port)
	go func() {
		log.Info("venue-service HTTP listening", zap.String("addr", addr))
		if httpErr := e.Start(addr); httpErr != nil && httpErr != http.ErrServerClosed {
			log.Fatal("HTTP server error", zap.Error(httpErr))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info("shutting down venue-service")
	grpcCancel()
	consumerCancel()
	sweeperCancel()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if shutdownErr := e.Shutdown(ctx); shutdownErr != nil {
		log.Error("HTTP shutdown error", zap.Error(shutdownErr))
	}
}
