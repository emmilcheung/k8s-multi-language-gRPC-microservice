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
	"github.com/acme/attendance-service/internal/config"
	gqlgraph "github.com/acme/attendance-service/internal/graphql"
	"github.com/acme/attendance-service/internal/handler"
	"github.com/acme/attendance-service/internal/health"
	appkafka "github.com/acme/attendance-service/internal/kafka"
	"github.com/acme/attendance-service/internal/middleware"
	"github.com/acme/attendance-service/internal/migrations"
	"github.com/acme/attendance-service/internal/qr"
	pgrepo "github.com/acme/attendance-service/internal/repository/postgres"
	"github.com/acme/attendance-service/internal/security"
	"github.com/acme/attendance-service/internal/service"
	"github.com/acme/attendance-service/internal/tracing"
	"github.com/acme/attendance-service/pkg/logger"
	ticketsv1 "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/labstack/echo-contrib/echoprometheus"
	"github.com/labstack/echo/v4"
	echomiddleware "github.com/labstack/echo/v4/middleware"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: invalid configuration: %v\n", err)
		os.Exit(1)
	}

	log, err := logger.New(cfg.LogLevel, "attendance-service")
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to create logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() //nolint:errcheck

	log.Info("starting attendance-service",
		zap.String("env", cfg.Env),
		zap.Int("port", cfg.Port),
	)

	shutdownTracing := tracing.InitWithEndpoint(context.Background(), "attendance-service", cfg.OTELEndpoint, log)
	defer shutdownTracing(context.Background())

	if err := migrations.Run(cfg.DatabaseURL, log); err != nil {
		log.Fatal("database migration failed", zap.Error(err))
	}

	pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Fatal("failed to create postgres pool", zap.Error(err))
	}
	defer pool.Close()

	if err := pool.Ping(context.Background()); err != nil {
		log.Fatal("postgres ping failed", zap.Error(err))
	}
	log.Info("postgres connected")

	// Health checkers
	dbChecker := health.NewDBChecker(pool)
	kafkaSecurity := appkafka.SecurityConfig{
		SecurityProtocol: cfg.KafkaSecurityProtocol,
		SASLMechanism:    cfg.KafkaSASLMechanism,
		SASLUsername:     cfg.KafkaSASLUsername,
		SASLPassword:     cfg.KafkaSASLPassword,
		SSLCALocation:    cfg.KafkaSSLCALocation,
	}
	kafkaChecker := health.NewKafkaChecker(cfg.KafkaBrokers, kafkaSecurity)

	// Kafka producer
	producer, err := appkafka.NewProducer(cfg.KafkaBrokers, log, kafkaSecurity)
	if err != nil {
		log.Fatal("failed to create Kafka producer", zap.Error(err))
	}
	defer producer.Close()

	// Repositories
	credRepo := pgrepo.NewCredentialRepo(pool)
	policyRepo := pgrepo.NewPolicyRepo(pool)
	scanRepo := pgrepo.NewScanRepo(pool)

	// Internal gRPC client: ticket-service (WS3 organizer ownership checks).
	// Use a blocking dial so that a misconfigured or unreachable TICKET_SERVICE_URL
	// causes an immediate startup failure rather than silently bypassing authorization.
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	// grpc.DialContext+WithBlock are deprecated since gRPC-go v1.56 but grpc.NewClient
	// removed blocking-dial support entirely; blocking at startup is required to fail loud.
	ticketConn, err := grpc.DialContext( //nolint:staticcheck
		dialCtx,
		cfg.TicketServiceURL,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(), //nolint:staticcheck
	)
	dialCancel()
	if err != nil {
		log.Fatal("failed to connect to ticket-service", zap.String("url", cfg.TicketServiceURL), zap.Error(err))
	}
	defer ticketConn.Close() //nolint:errcheck
	ticketLookup := service.NewGRPCTicketOwnerLookup(ticketsv1.NewTicketServiceClient(ticketConn), 0)

	// Service
	svc := service.NewAttendanceServiceWithTicketLookup(credRepo, policyRepo, scanRepo, ticketLookup)

	// QR token generator
	qrGen := qr.NewGenerator(cfg.QRSigningKey)
	scanSvc := service.NewScanService(credRepo, scanRepo, qrGen, log)

	// IssuanceService: implements kafka.OrderEventHandler and issues admission
	// credentials for each completed order event (WS2).
	issuanceSvc := service.NewIssuanceService(credRepo, qrGen, cfg.QRTokenTTL, log)
	// WS2 keeps a single process-local outbox relay per deployment; row claiming
	// across multiple instances is intentionally out of scope for this pass.
	outboxRelay := service.NewOutboxRelay(pool, credRepo, producer, log)

	// Kafka consumer
	consumer, err := appkafka.NewOrderConsumer(
		cfg.KafkaBrokers, "attendance-service",
		issuanceSvc,
		producer, log, kafkaSecurity,
	)
	if err != nil {
		log.Fatal("failed to create Kafka order consumer", zap.Error(err))
	}
	consumerCtx, consumerCancel := context.WithCancel(context.Background())
	defer consumerCancel()
	go consumer.Start(consumerCtx)
	go outboxRelay.Run(consumerCtx, 2*time.Second, 100)

	// Echo setup
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	e.Use(otelecho.Middleware("attendance-service"))
	e.Use(echomiddleware.RequestID())
	e.Use(middleware.RequestLogger(log))
	e.Use(echomiddleware.Recover())

	// Handlers
	healthHandler := handler.NewHealthHandler(dbChecker, kafkaChecker, log)
	attendanceHandler := handler.NewAttendanceHandler(svc, log)
	scanHandler := handler.NewScanHandler(scanSvc, svc, log)

	// Health routes (no auth)
	e.GET("/healthz/live", healthHandler.Live)
	e.GET("/healthz/ready", healthHandler.Ready)

	// Prometheus metrics
	e.GET("/metrics", echoprometheus.NewHandler())
	e.Use(echoprometheus.NewMiddleware("http"))

	// GraphQL (no auth at transport; auth via context in resolvers)
	gqlResolver := &gqlgraph.Resolver{Svc: svc, ScanSvc: scanSvc}
	gqlServer := gqlhandler.NewDefaultServer(gqlgraph.NewExecutableSchema(gqlgraph.Config{
		Resolvers: gqlResolver,
	}))
	sigValidator := security.NewUserIDSignatureValidator(cfg.UserIDSigningKey)
	gqlHandler := gqlgraph.WrapWithUserIDSignatureValidation(gqlServer, sigValidator)
	e.POST("/graphql", func(c echo.Context) error {
		ctx := gqlgraph.WithHTTPRequest(c.Request().Context(), c.Request())
		gqlHandler.ServeHTTP(c.Response(), c.Request().WithContext(ctx))
		return nil
	})
	e.GET("/graphql", func(c echo.Context) error {
		ctx := gqlgraph.WithHTTPRequest(c.Request().Context(), c.Request())
		gqlHandler.ServeHTTP(c.Response(), c.Request().WithContext(ctx))
		return nil
	})

	// Buyer REST routes
	buyer := e.Group("/api/attendance", middleware.KongAuth(true))
	buyer.GET("/tickets/:ticketId", attendanceHandler.GetTicket)

	// Organizer REST routes
	organizer := e.Group("/api/attendance", middleware.KongAuth(true))
	organizer.GET("/events/:eventId/settings", attendanceHandler.GetEventSettings)
	organizer.PATCH("/events/:eventId/settings", attendanceHandler.PatchEventSettings)
	organizer.GET("/events/:eventId/summary", attendanceHandler.GetEventSummary)
	organizer.GET("/events/:eventId/checkins", attendanceHandler.GetEventCheckIns)

	// Scanner REST routes (authenticated scanner identity via Kong headers)
	scanner := e.Group("/api/attendance/scan", middleware.KongAuth(true))
	scanner.POST("/validate", scanHandler.ValidateToken)
	scanner.POST("/check-in", scanHandler.CheckIn)
	scanner.POST("/check-in-user", scanHandler.CheckInByBuyer)

	// Graceful shutdown
	serverAddr := fmt.Sprintf(":%d", cfg.Port)
	server := &http.Server{
		Addr:         serverAddr,
		Handler:      e,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Info("HTTP server listening", zap.String("addr", serverAddr))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("HTTP server error", zap.Error(err))
		}
	}()

	<-quit
	log.Info("shutdown signal received")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Error("HTTP server shutdown error", zap.Error(err))
	}
	log.Info("attendance-service stopped")
}
