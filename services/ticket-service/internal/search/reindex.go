package search

import (
	"context"
	"fmt"
	"strconv"

	"github.com/acme/ticket-service/internal/repository"
	"go.uber.org/zap"
)

// TicketRepository is the subset of repository.TicketRepository used by Reindex.
// Using a local interface keeps the search package free of a hard dependency on
// the full repository interface and makes it straightforward to stub in tests.
type TicketRepository interface {
	FindAll(ctx context.Context, p repository.PaginationParams) ([]*repository.Ticket, error)
}

// ticketToDoc maps a repository.Ticket to a search Doc.
// This mirrors eventToDoc but reads directly from the Mongo model rather than a
// Kafka CloudEvent payload. Both paths must produce identical Doc values for the
// same ticket state — do not add logic here that is absent from eventToDoc.
func ticketToDoc(t *repository.Ticket) Doc {
	price, _ := strconv.ParseFloat(t.Price, 64) //nolint:errcheck

	doc := Doc{
		ID:            t.ID,
		Version:       t.Version,
		Title:         t.Title,
		Category:      t.Category,
		TicketType:    t.TicketType,
		SeatingPlanID: t.SeatingPlanID,
		Price:         price,
		CreatedAt:     t.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	if t.Event != nil {
		doc.EventTitle = t.Event.Title
		doc.VenueName = t.Event.VenueName
		doc.Description = t.Event.Description
		doc.VenueAddress = t.Event.VenueAddress
		doc.StartsAt = t.Event.StartsAt.Format("2006-01-02T15:04:05Z")
	}

	return doc
}

// Reindex pages through ALL tickets via repo.FindAll (cursor paging, newest-first)
// and upserts each one into the OpenSearch index via client.UpsertTicket.
// pageSize controls how many tickets are fetched per page (capped at 100 by FindAll).
// Progress is logged per page as "reindex_progress".
func Reindex(ctx context.Context, repo TicketRepository, client *Client, pageSize int) error {
	var (
		after string
		total int
	)

	for {
		page, err := repo.FindAll(ctx, repository.PaginationParams{
			After: after,
			Limit: pageSize,
		})
		if err != nil {
			return fmt.Errorf("search.Reindex: FindAll (after=%q): %w", after, err)
		}
		if len(page) == 0 {
			break
		}

		for _, t := range page {
			doc := ticketToDoc(t)
			if upsertErr := client.UpsertTicket(ctx, doc); upsertErr != nil {
				return fmt.Errorf("search.Reindex: upsert ticket %s: %w", t.ID, upsertErr)
			}
		}

		total += len(page)
		last := page[len(page)-1]
		after = repository.EncodeCursor(last.CreatedAt, last.ID)

		client.log.Info("reindex_progress",
			zap.Int("page_size", len(page)),
			zap.Int("total_done", total),
			zap.String("next_cursor", after),
		)

		// If the page was smaller than pageSize we've reached the last page.
		if len(page) < pageSize {
			break
		}
	}

	client.log.Info("reindex complete", zap.Int("total_indexed", total))
	return nil
}
