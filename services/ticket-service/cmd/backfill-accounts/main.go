// Command backfill-accounts gives every existing ticket an owning organizer
// account: it asks user-service for each creator's personal account and records
// it on the creator's tickets. userId stays on the ticket as "created by". It is
// idempotent and resumable, so it can be stopped and run again, and a re-run
// also picks up tickets created since the last run.
//
// Run it outside on-sale windows. Running it against any environment other
// than local needs the owner's explicit approval.
//
// Required environment variables:
//
//	MONGO_URI           — MongoDB connection URI
//	ACCOUNTS_GRPC_ADDR  — user-service gRPC address (for example localhost:50053)
//
// Optional:
//
//	MONGO_DB               — database name (default: tickets)
//	BACKFILL_DRY_RUN       — "true" prints how many tickets and owners are pending and changes nothing
//	BACKFILL_BATCH_SIZE    — owners per round (default 100)
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

	accountsv1 "github.com/org/ticketing/libs/grpc-stubs/go/accounts/v1"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/acme/ticket-service/internal/backfill"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/pkg/logger"
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

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	mongoURI := os.Getenv("MONGO_URI")
	accountsAddr := strings.TrimSpace(os.Getenv("ACCOUNTS_GRPC_ADDR"))
	if mongoURI == "" || accountsAddr == "" {
		return fmt.Errorf("MONGO_URI and ACCOUNTS_GRPC_ADDR are required")
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

	log, err := logger.New(getEnv("LOG_LEVEL", "info"), "ticket-backfill-accounts")
	if err != nil {
		return fmt.Errorf("create logger: %w", err)
	}
	defer log.Sync() //nolint:errcheck

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, getEnv("MONGO_DB", "tickets"))
	if err != nil {
		return fmt.Errorf("connect to MongoDB: %w", err)
	}
	defer repo.Close(ctx) //nolint:errcheck

	conn, err := grpc.NewClient(accountsAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("dial user-service: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	reg := prometheus.NewRegistry()
	ticketsDone := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "ticket_backfill_accounts_tickets_done",
		Help: "Tickets given an owning account by this run.",
	})
	ownersDone := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "ticket_backfill_accounts_owners_done",
		Help: "Distinct owners whose personal account this run ensured.",
	})
	reg.MustRegister(ticketsDone, ownersDone)
	report := func(r backfill.Result) {
		ticketsDone.Set(float64(r.Tickets))
		ownersDone.Set(float64(r.Owners))
		if file := os.Getenv("BACKFILL_METRICS_FILE"); file != "" {
			if err := prometheus.WriteToTextfile(file, reg); err != nil {
				log.Warn("write metrics file", zap.Error(err))
			}
		}
	}

	log.Info("starting ticket ownership backfill", zap.Bool("dry_run", dryRun), zap.Int("batch_size", batchSize))
	res, err := backfill.Run(ctx, repo, grpcAccounts{accountsv1.NewAccountsServiceClient(conn)}, backfill.Options{
		BatchSize:  batchSize,
		Throttle:   throttle,
		DryRun:     dryRun,
		Log:        log,
		OnProgress: report,
	})
	if err != nil {
		return err
	}
	report(res)
	if dryRun {
		log.Info("dry run: nothing changed", zap.Int("tickets_pending", res.Tickets), zap.Int("owners_pending", res.Owners))
		return nil
	}
	log.Info("ticket ownership backfill finished", zap.Int("tickets_done", res.Tickets), zap.Int("owners_done", res.Owners))
	return nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
