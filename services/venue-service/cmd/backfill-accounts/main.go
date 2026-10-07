// Command backfill-accounts gives every existing venue an owning organizer
// account: it asks user-service for each creator's personal account, makes the
// creator a venue manager of their venue, and records the account on the venue.
// It is idempotent and resumable, so it can be stopped and run again.
//
// Run it outside on-sale windows. Running it against any environment other
// than local needs the owner's explicit approval.
//
// Required environment variables:
//
//	DATABASE_URL        — PostgreSQL connection URL
//	ACCOUNTS_GRPC_ADDR  — user-service gRPC address (for example localhost:50053)
//
// Optional:
//
//	BACKFILL_DRY_RUN       — "true" prints how many venues and owners are pending and changes nothing
//	BACKFILL_BATCH_SIZE    — venues per round (default 100)
//	BACKFILL_THROTTLE      — pause between rounds, a Go duration (default 200ms)
//	BACKFILL_METRICS_FILE  — write progress metrics here in Prometheus text format
//	LOG_LEVEL              — log level (default info)
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	accountsv1 "github.com/org/ticketing/libs/grpc-stubs/go/accounts/v1"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/acme/venue-service/internal/backfill"
	"github.com/acme/venue-service/pkg/logger"
)

const rpcTimeout = 5 * time.Second

type grpcAccounts struct {
	client accountsv1.AccountsServiceClient
}

func (g grpcAccounts) EnsurePersonalAccount(ctx context.Context, userID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	res, err := g.client.EnsurePersonalAccount(ctx, &accountsv1.EnsurePersonalAccountRequest{UserId: userID})
	if err != nil {
		return "", err
	}
	return res.GetAccountId(), nil
}

func (g grpcAccounts) EnsureVenueManager(ctx context.Context, userID, venueID string) error {
	ctx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	_, err := g.client.EnsureVenueManager(ctx, &accountsv1.EnsureVenueManagerRequest{UserId: userID, VenueId: venueID})
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	databaseURL := os.Getenv("DATABASE_URL")
	accountsAddr := strings.TrimSpace(os.Getenv("ACCOUNTS_GRPC_ADDR"))
	if databaseURL == "" || accountsAddr == "" {
		return fmt.Errorf("DATABASE_URL and ACCOUNTS_GRPC_ADDR are required")
	}
	dryRun, err := strconv.ParseBool(getEnv("BACKFILL_DRY_RUN", "false"))
	if err != nil {
		return fmt.Errorf("BACKFILL_DRY_RUN: %w", err)
	}
	batchSize, err := strconv.Atoi(getEnv("BACKFILL_BATCH_SIZE", "100"))
	if err != nil || batchSize <= 0 {
		return fmt.Errorf("BACKFILL_BATCH_SIZE must be a positive integer")
	}
	throttle, err := time.ParseDuration(getEnv("BACKFILL_THROTTLE", "200ms"))
	if err != nil || throttle < 0 {
		return fmt.Errorf("BACKFILL_THROTTLE must be a non-negative duration such as 200ms")
	}

	log, err := logger.New(getEnv("LOG_LEVEL", "info"), "venue-backfill-accounts")
	if err != nil {
		return fmt.Errorf("create logger: %w", err)
	}
	defer log.Sync() //nolint:errcheck

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	defer pool.Close()

	conn, err := grpc.NewClient(accountsAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("dial user-service: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	reg := prometheus.NewRegistry()
	venuesDone := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "venue_backfill_accounts_venues_done",
		Help: "Venues given an owning account by this run.",
	})
	ownersDone := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "venue_backfill_accounts_owners_done",
		Help: "Distinct owners whose personal account this run ensured.",
	})
	reg.MustRegister(venuesDone, ownersDone)
	writeMetrics := func() {
		if file := os.Getenv("BACKFILL_METRICS_FILE"); file != "" {
			if err := prometheus.WriteToTextfile(file, reg); err != nil {
				log.Warn("write metrics file", zap.Error(err))
			}
		}
	}

	log.Info("starting venue ownership backfill", zap.Bool("dry_run", dryRun), zap.Int("batch_size", batchSize))
	res, err := backfill.Run(ctx, pool, grpcAccounts{accountsv1.NewAccountsServiceClient(conn)}, backfill.Options{
		BatchSize: batchSize,
		Throttle:  throttle,
		DryRun:    dryRun,
		Log:       log,
		OnProgress: func(r backfill.Result) {
			venuesDone.Set(float64(r.Venues))
			ownersDone.Set(float64(r.Owners))
			writeMetrics()
		},
	})
	if err != nil {
		return err
	}
	venuesDone.Set(float64(res.Venues))
	ownersDone.Set(float64(res.Owners))
	writeMetrics()
	if dryRun {
		log.Info("dry run: nothing changed", zap.Int("venues_pending", res.Venues), zap.Int("owners_pending", res.Owners))
		return nil
	}
	log.Info("venue ownership backfill finished", zap.Int("venues_done", res.Venues), zap.Int("owners_done", res.Owners))
	return nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
