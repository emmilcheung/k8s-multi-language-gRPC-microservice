package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	gqlhandler "github.com/99designs/gqlgen/graphql/handler"
	"github.com/acme/venue-service/internal/config"
	gqlgraph "github.com/acme/venue-service/internal/graphql"
	grpcserver "github.com/acme/venue-service/internal/grpc"
	"github.com/acme/venue-service/internal/handler"
	"github.com/acme/venue-service/internal/health"
	"github.com/acme/venue-service/internal/hold"
	"github.com/acme/venue-service/internal/kafka"
	"github.com/acme/venue-service/internal/middleware"
	"github.com/acme/venue-service/internal/migrations"
	"github.com/acme/venue-service/internal/reconciler"
	pgrepo "github.com/acme/venue-service/internal/repository/postgres"
	"github.com/acme/venue-service/internal/security"
	"github.com/acme/venue-service/internal/service"
	"github.com/acme/venue-service/internal/sse"
	"github.com/acme/venue-service/internal/tracing"
	"github.com/acme/venue-service/pkg/logger"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo-contrib/echoprometheus"
	"github.com/labstack/echo/v4"
	echomiddleware "github.com/labstack/echo/v4/middleware"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
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
	kafkaSecurity := kafka.SecurityConfig{
		SecurityProtocol: cfg.KafkaSecurityProtocol,
		SASLMechanism:    cfg.KafkaSASLMechanism,
		SASLUsername:     cfg.KafkaSASLUsername,
		SASLPassword:     cfg.KafkaSASLPassword,
		SSLCALocation:    cfg.KafkaSSLCALocation,
	}
	kafkaChecker := health.NewKafkaChecker(cfg.KafkaBrokers, kafkaSecurity)

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
	producer, err := kafka.NewProducer(cfg.KafkaBrokers, log, kafkaSecurity)
	if err != nil {
		log.Fatal("failed to create Kafka producer", zap.Error(err))
	}
	defer producer.Close()

	// Repositories.
	venueRepo := pgrepo.NewVenueRepo(pool)
	venueSectionRepo := pgrepo.NewVenueSectionRepo(pool)
	planRepo := pgrepo.NewPlanRepo(pool)
	sectionRepo := pgrepo.NewSectionRepo(pool)
	priceTierRepo := pgrepo.NewPriceTierRepo(pool)
	reservationRepo := pgrepo.NewReservationRepo(pool)

	// Business logic service (implements OrderEventHandler for Kafka consumer).
	svc := service.NewVenueService(reservationRepo, sectionRepo, log)

	// Hold manager — Redis hot path + PostgreSQL fallback.
	// holdTTL determines how long seats are reserved during the hold phase.
	holdTTL := time.Duration(cfg.HoldTTLSec) * time.Second
	holdMgr := hold.NewManager(redisClient, sectionRepo, planRepo, holdTTL, log)

	// SSE broadcaster — real-time seat state fan-out to connected clients.
	// Uses Redis pub/sub when Redis is available; falls through to in-process fan-out.
	sseBroadcaster := sse.NewBroadcaster(redisClient, log)

	// Wire broadcaster into hold manager for no-Redis in-process fan-out.
	holdMgr.WithBroadcaster(sseBroadcaster)

	// Start SSE heartbeat goroutine.
	heartbeatCtx, heartbeatCancel := context.WithCancel(context.Background())
	defer heartbeatCancel()
	sseBroadcaster.StartHeartbeat(heartbeatCtx)

	// Hold sweeper — releases expired holds every 30 seconds.
	sweeper := hold.NewSweeper(holdMgr, 30*time.Second, log)
	sweeperCtx, sweeperCancel := context.WithCancel(context.Background())
	defer sweeperCancel()
	go sweeper.Start(sweeperCtx)

	// Redis reconciler — re-seeds the seat state hash after a Redis restart.
	// Only started when Redis is configured; no-op otherwise.
	var reconcilerCancel context.CancelFunc
	if redisClient != nil {
		rec := reconciler.NewReconciler(redisClient, planRepo, sectionRepo, 5*time.Minute, log)
		var reconcilerCtx context.Context
		reconcilerCtx, reconcilerCancel = context.WithCancel(context.Background())
		defer reconcilerCancel()
		go rec.Start(reconcilerCtx)
	}

	// Kafka consumer — listens to order lifecycle events.
	orderConsumer, err := kafka.NewOrderConsumer(cfg.KafkaBrokers, "venue-service", svc, producer, log, kafkaSecurity)
	if err != nil {
		log.Fatal("failed to create Kafka order consumer", zap.Error(err))
	}
	consumerCtx, consumerCancel := context.WithCancel(context.Background())
	defer consumerCancel()
	go orderConsumer.Start(consumerCtx)

	// Create gRPC client to ticket-service for GetTicket calls.
	ticketConn, err := grpc.NewClient(
		cfg.TicketServiceURL,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(10*1024*1024)),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	)
	if err != nil {
		log.Fatal("failed to connect to ticket-service", zap.Error(err))
	}
	defer ticketConn.Close() //nolint:errcheck
	ticketClient := grpcserver.NewResilientTicketClient(ticketsv1.NewTicketServiceClient(ticketConn), log)

	// gRPC server — wired with real repos in CP-08.
	grpcSrv := grpcserver.NewVenueGrpcServer(reservationRepo, sectionRepo, planRepo, ticketClient, log)
	grpcCtx, grpcCancel := context.WithCancel(context.Background())
	defer grpcCancel()
	grpcAddr := fmt.Sprintf(":%d", cfg.GrpcPort)

	// Signature validator — validates X-User-Id-Sig headers signed by Kong.
	sigValidator := security.NewUserIDSignatureValidator(cfg.UserIDSigningKey)

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

	venueHandler := handler.NewVenueHandler(venueRepo, sigValidator, log)
	venueHandler.RegisterRoutes(api.Group("/venues"))

	venueSectionHandler := handler.NewVenueSectionHandler(venueRepo, venueSectionRepo, sigValidator, log)
	venueSectionHandler.RegisterRoutes(api.Group("/venues/:venueId"))

	planHandler := handler.NewPlanHandler(planRepo, sectionRepo, sigValidator, log)
	planHandler.RegisterRoutes(api.Group("/seating-plans"))

	sectionHandler := handler.NewSectionHandler(planRepo, sectionRepo, priceTierRepo, sigValidator, log)
	sectionHandler.RegisterRoutes(api.Group("/seating-plans/:planId"))

	seatHoldHandler := handler.NewSeatHoldHandler(holdMgr, sigValidator, log)
	seatHoldHandler.RegisterRoutes(api.Group("/seating-plans/:planId"))

	sseHandler := handler.NewSSEHandler(sseBroadcaster, log)
	sseHandler.RegisterRoutes(api.Group("/seating-plans/:planId"))

	// GraphQL federation subgraph.
	// A per-request DataLoader middleware is wrapped around the handler so that
	// every _entities batch call gets its own loader instance (prevents
	// cross-request data leaks and keeps the per-request cache correct).
	gqlResolver := &gqlgraph.Resolver{PlanRepo: planRepo, SectionRepo: sectionRepo}
	gqlSrv := gqlhandler.NewDefaultServer(gqlgraph.NewExecutableSchema(gqlgraph.Config{Resolvers: gqlResolver}))
	gqlHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		loader := gqlgraph.NewPlanLoader(planRepo, sectionRepo)
		ctx := gqlgraph.WithPlanLoader(r.Context(), loader)
		gqlSrv.ServeHTTP(w, r.WithContext(ctx))
	})
	e.POST("/graphql", echo.WrapHandler(gqlgraph.WrapWithUserIDSignatureValidation(gqlHandler, sigValidator)))

	// R-06: Use errgroup to propagate server errors back to main instead of
	// calling log.Fatal inside goroutines (which calls os.Exit, skipping all deferred cleanup).
	eg, egCtx := errgroup.WithContext(context.Background())

	eg.Go(func() error {
		return grpcserver.Start(grpcCtx, grpcAddr, grpcSrv, log)
	})

	addr := fmt.Sprintf(":%d", cfg.Port)
	eg.Go(func() error {
		log.Info("venue-service HTTP listening", zap.String("addr", addr))
		if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
			return fmt.Errorf("HTTP server: %w", err)
		}
		return nil
	})

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-quit:
		log.Info("shutting down venue-service (signal received)")
	case <-egCtx.Done():
		log.Error("server error — initiating shutdown")
	}

	grpcCancel()
	consumerCancel()
	sweeperCancel()
	if reconcilerCancel != nil {
		reconcilerCancel()
	}
	heartbeatCancel()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if shutdownErr := e.Shutdown(ctx); shutdownErr != nil {
		log.Error("HTTP shutdown error", zap.Error(shutdownErr))
	}
	if err := eg.Wait(); err != nil {
		log.Error("server exited with error", zap.Error(err))
	}
}
