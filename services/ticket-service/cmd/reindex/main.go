// Command reindex bulk-loads all existing tickets from MongoDB into the
// OpenSearch index. Run this as a one-shot job when bootstrapping the index
// or after a mapping change that requires a full backfill.
//
// Required environment variables (same as the server):
//
//	MONGO_URI         — MongoDB connection URI
//	OPENSEARCH_URL    — OpenSearch base URL (e.g. http://localhost:9200)
//
// Optional:
//
//	MONGO_DB          — database name (default: tickets)
//	OPENSEARCH_INDEX  — index name (default: tickets)
//	LOG_LEVEL         — log level (default: info)
package main

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/acme/ticket-service/internal/repository"
	"github.com/acme/ticket-service/internal/search"
	"github.com/acme/ticket-service/pkg/logger"
	"go.uber.org/zap"
)

func main() {
	mongoURI := os.Getenv("MONGO_URI")
	if mongoURI == "" {
		fmt.Fprintln(os.Stderr, "FATAL: MONGO_URI is required")
		os.Exit(1)
	}
	openSearchURL := os.Getenv("OPENSEARCH_URL")
	if openSearchURL == "" {
		fmt.Fprintln(os.Stderr, "FATAL: OPENSEARCH_URL is required")
		os.Exit(1)
	}

	mongoDB := getEnv("MONGO_DB", "tickets")
	openSearchIndex := getEnv("OPENSEARCH_INDEX", "tickets")
	logLevel := getEnv("LOG_LEVEL", "info")

	pageSize := 500
	if ps := os.Getenv("REINDEX_PAGE_SIZE"); ps != "" {
		n, err := strconv.Atoi(ps)
		if err != nil || n <= 0 {
			fmt.Fprintf(os.Stderr, "WARN: REINDEX_PAGE_SIZE=%q is invalid (must be a positive integer); using default %d\n", ps, pageSize)
		} else {
			pageSize = n
		}
	}

	log, err := logger.New(logLevel, "ticket-reindex")
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: create logger: %v\n", err)
		os.Exit(1)
	}
	defer log.Sync() //nolint:errcheck

	ctx := context.Background()

	repo, err := repository.NewMongoTicketRepository(ctx, mongoURI, mongoDB)
	if err != nil {
		log.Fatal("connect to MongoDB", zap.Error(err))
	}
	defer repo.Close(ctx) //nolint:errcheck

	client, err := search.NewClient(openSearchURL, openSearchIndex, log)
	if err != nil {
		log.Fatal("create search client", zap.Error(err))
	}

	if err := client.EnsureIndex(ctx); err != nil {
		log.Fatal("ensure index", zap.Error(err))
	}

	log.Info("starting reindex",
		zap.String("opensearch_url", openSearchURL),
		zap.String("index", openSearchIndex),
		zap.Int("page_size", pageSize),
	)

	if err := search.Reindex(ctx, repo, client, pageSize, nil); err != nil {
		log.Fatal("reindex failed", zap.Error(err))
	}

	log.Info("reindex finished successfully")
}

func getEnv(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
