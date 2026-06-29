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
	"github.com/acme/ticket-service/internal/cache"
	"github.com/acme/ticket-service/internal/config"
	gqlgraph "github.com/acme/ticket-service/internal/graphql"
	grpcserver "github.com/acme/ticket-service/internal/grpc"
	"github.com/acme/ticket-service/internal/handler"
	"github.com/acme/ticket-service/internal/health"
	"github.com/acme/ticket-service/internal/kafka"
	"github.com/acme/ticket-service/internal/metrics"
	"github.com/acme/ticket-service/internal/middleware"
	"github.com/acme/ticket-service/internal/outbox"
	"github.com/acme/ticket-service/internal/reconciler"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/search"
	"github.com/acme/ticket-service/internal/security"
	"github.com/acme/ticket-service/internal/service"
	"github.com/acme/ticket-service/internal/tracing"
	"github.com/acme/ticket-service/pkg/logger"
	"github.com/labstack/echo-contrib/echoprometheus"
	"github.com/labstack/echo/v4"
	echomiddleware "github.com/labstack/echo/v4/middleware"
	venuev1 "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
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

	if cfg.Env == "production" && len(os.Getenv("X_USER_ID_SIGNING_KEY")) < 32 {
		log.Fatal("X_USER_ID_SIGNING_KEY must be at least 32 characters in production")
	}

	log.Info("starting ticket-service", zap.String("env", cfg.Env), zap.Int("port", cfg.Port), zap.Int("grpcPort", cfg.GrpcPort))

	// Initialise OpenTelemetry — must happen before any network I/O
	shutdownTracing := tracing.Init(context.Background(), "ticket-service", log)
	defer shutdownTracing(context.Background())

	// MongoDB connection — used by saved-event repository;
	// ticket repository creates its own client internally.
	clientOpts := options.Client().ApplyURI(cfg.MongoURI)
	mongoClient, err := mongo.Connect(clientOpts)
	if err != nil {
		log.Fatal("failed to connect to MongoDB", zap.Error(err))
	}
	if err := mongoClient.Ping(context.Background(), nil); err != nil {
		log.Fatal("failed to ping MongoDB", zap.Error(err))
	}
	defer mongoClient.Disconnect(context.Background()) //nolint:errcheck

	// MongoDB repositories
	mongoRepo, err := repository.NewMongoTicketRepository(context.Background(), cfg.MongoURI, cfg.MongoDB)
	if err != nil {
		log.Fatal("failed to initialize ticket repository", zap.Error(err))
	}
	defer mongoRepo.Close(context.Background()) //nolint:errcheck

	savedEventRepo, err := repository.NewMongoSavedEventRepository(mongoClient, cfg.MongoDB)
	if err != nil {
		log.Fatal("failed to initialize saved-event repository", zap.Error(err))
	}

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

		// Shared-Redis stale-while-revalidate cache: hot-key reads serve from
		// Redis and are refreshed by a single fleet-wide background worker, so
		// no per-pod state and no cache-expiry stampede onto Mongo.
		ticketCache := cache.NewRedisSWRCache(redisClient)
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
	kafkaSecurity := kafka.SecurityConfig{
		SecurityProtocol: cfg.KafkaSecurityProtocol,
		SASLMechanism:    cfg.KafkaSASLMechanism,
		SASLUsername:     cfg.KafkaSASLUsername,
		SASLPassword:     cfg.KafkaSASLPassword,
		SSLCALocation:    cfg.KafkaSSLCALocation,
	}
	producer, err := kafka.NewProducer(cfg.KafkaBrokers, log, kafkaSecurity)
	if err != nil {
		log.Fatal("failed to create Kafka producer", zap.Error(err))
	}
	defer producer.Close()
	kafkaChecker = health.NewKafkaChecker(cfg.KafkaBrokers, kafkaSecurity)
	outboxRelay := outbox.NewRelay(mongoRepo, producer, log)

	// Kafka consumer — listens to order events and keeps ticket reservation state in sync.
	// The producer is passed so the consumer can route failed messages to the DLQ.
	orderConsumer, err := kafka.NewOrderConsumer(cfg.KafkaBrokers, "ticket-service", ticketRepo, producer, log, kafkaSecurity)
	if err != nil {
		log.Fatal("failed to create Kafka order consumer", zap.Error(err))
	}
	consumerCtx, consumerCancel := context.WithCancel(context.Background())
	defer consumerCancel()
	go orderConsumer.Start(consumerCtx)

	relayCtx, relayCancel := context.WithCancel(context.Background())
	defer relayCancel()
	go outboxRelay.Start(relayCtx)

	// Register search Prometheus metrics on the default registry.
	// These are always registered regardless of SEARCH_BACKEND so that the
	// metric descriptors are present at startup (avoids "metric not found" gaps).
	searchMetrics := metrics.NewSearchMetrics(prometheus.DefaultRegisterer)

	// Optionally initialise OpenSearch — search client is attached to svc after svc is created.
	var openSearchClient *search.Client
	if cfg.SearchBackend == "opensearch" {
		sc, err := search.NewClient(cfg.OpenSearchURL, cfg.OpenSearchIndex, log)
		if err != nil {
			log.Fatal("failed to create search client", zap.Error(err))
		}
		ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer ensureCancel()
		if err := sc.EnsureIndex(ensureCtx); err != nil {
			log.Fatal("ensure search index", zap.Error(err))
		}
		openSearchClient = sc
	}

	// WS3: Venue-service gRPC client for fetching seating plan assignment mode
	venueConn, err := grpc.NewClient(
		cfg.VenueServiceAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(10*1024*1024)),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	)
	if err != nil {
		log.Fatal("failed to dial venue-service", zap.Error(err), zap.String("addr", cfg.VenueServiceAddr))
	}
	defer venueConn.Close() //nolint:errcheck
	venueClient := service.NewResilientVenueClient(venuev1.NewVenueServiceClient(venueConn), log)
	log.Info("connected to venue-service", zap.String("addr", cfg.VenueServiceAddr))

	// Business logic service
	svc := service.NewTicketService(ticketRepo, producer, log, venueClient, savedEventRepo)

	// Wire search client + start indexer now that svc and Kafka producer exist.
	if openSearchClient != nil {
		svc.WithSearchClient(openSearchClient)
		indexer, err := search.NewIndexer(openSearchClient, cfg.KafkaBrokers, log, kafkaSecurity, producer)
		if err != nil {
			log.Fatal("search indexer", zap.Error(err))
		}
		indexer.WithMetrics(searchMetrics)
		idxCtx, idxCancel := context.WithCancel(context.Background())
		defer idxCancel()
		go func() {
			if err := indexer.Run(idxCtx); err != nil {
				log.Error("search indexer stopped", zap.Error(err))
			}
		}()
	}

	// gRPC server — runs alongside HTTP in a separate goroutine
	grpcCtx, grpcCancel := context.WithCancel(context.Background())
	defer grpcCancel()
	grpcAddr := fmt.Sprintf(":%d", cfg.GrpcPort)
	grpcSrv := grpcserver.NewTicketGrpcServer(ticketRepo, log)

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
	signingKey := os.Getenv("X_USER_ID_SIGNING_KEY")
	signatureValidator := security.NewUserIDSignatureValidator(signingKey)
	ticketHandler := handler.NewTicketHandler(svc, log, signatureValidator)
	v1 := e.Group("/api/tickets")
	v1.POST("", ticketHandler.Create)
	v1.GET("", ticketHandler.List)
	v1.GET("/:id", ticketHandler.GetByID)
	v1.PUT("/:id", ticketHandler.Update)

	// GraphQL federation subgraph endpoint.
	// A per-request DataLoader middleware is wrapped around the handler so that
	// every _entities batch call gets its own loader instance (prevents
	// cross-request data leaks and keeps the per-request cache correct).
	gqlResolver := &gqlgraph.Resolver{TicketService: svc, Config: cfg, Log: log, SearchMetrics: searchMetrics}
	gqlSrv := gqlhandler.NewDefaultServer(gqlgraph.NewExecutableSchema(gqlgraph.Config{Resolvers: gqlResolver}))
	gqlHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		loader := gqlgraph.NewTicketLoader(svc)
		ctx := gqlgraph.WithTicketLoader(r.Context(), loader)
		ctx = gqlgraph.WithUserID(ctx, r.Header.Get("X-User-Id"))
		gqlSrv.ServeHTTP(w, r.WithContext(ctx))
	})
	e.POST("/graphql", echo.WrapHandler(gqlgraph.WrapWithUserIDSignatureValidation(gqlHandler, signatureValidator)))

	// R-06: Use errgroup to propagate server errors back to main instead of
	// calling log.Fatal inside goroutines (which calls os.Exit, skipping all deferred cleanup).
	eg, egCtx := errgroup.WithContext(context.Background())

	eg.Go(func() error {
		return grpcserver.Start(grpcCtx, grpcAddr, grpcSrv, log)
	})

	addr := fmt.Sprintf(":%d", cfg.Port)
	eg.Go(func() error {
		log.Info("ticket-service listening", zap.String("addr", addr))
		if err := e.Start(addr); err != nil && err != http.ErrServerClosed {
			return fmt.Errorf("HTTP server: %w", err)
		}
		return nil
	})

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-quit:
		log.Info("shutting down ticket-service (signal received)")
	case <-egCtx.Done():
		log.Error("server error — initiating shutdown")
	}

	grpcCancel() // signal gRPC server to stop
	relayCancel()
	consumerCancel()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := e.Shutdown(ctx); err != nil {
		log.Error("shutdown error", zap.Error(err))
	}
	if err := eg.Wait(); err != nil {
		log.Error("server exited with error", zap.Error(err))
	}
}
