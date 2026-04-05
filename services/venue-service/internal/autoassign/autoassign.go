// Package autoassign implements the seat auto-assignment algorithm for venue-service.
//
// # Algorithm overview (§10 of venue-seating-plan-design.md)
//
//  1. Group available seats by row label.
//  2. Within each row, find all contiguous runs of requested quantity.
//  3. Score each candidate run: front rows score higher; within a row,
//     centre columns score higher.
//  4. Return the highest-scoring run.
//  5. Cross-row fallback: if no single row has a contiguous block, fill from
//     the front rows using the best individual seats.
//
// Guardrails: search window is capped at maxWindowPerRow to avoid O(N²)
// brute-force on very large sections.
package autoassign

import (
	"errors"
	"math"
	"sort"

	"github.com/acme/venue-service/internal/repository"
)

// ErrNotEnoughSeats is returned when there are fewer available seats than
// the requested quantity.
var ErrNotEnoughSeats = errors.New("not enough available seats")

// maxWindowPerRow caps the number of contiguous-run candidates examined per row
// to avoid O(N²) search on very large rows.
const maxWindowPerRow = 200

// FindBestBlock selects the best contiguous (or near-contiguous) block of
// `quantity` seats from the provided available seats slice.
//
// Seats must be AVAILABLE status; any other status is filtered out internally.
// The returned slice contains seat IDs in row/column order.
func FindBestBlock(seats []*repository.Seat, quantity int) ([]string, error) {
	if quantity <= 0 {
		return nil, errors.New("quantity must be greater than zero")
	}

	// Filter to only AVAILABLE seats.
	available := make([]*repository.Seat, 0, len(seats))
	for _, s := range seats {
		if s.Status == repository.SeatStatusAvailable {
			available = append(available, s)
		}
	}

	if len(available) < quantity {
		return nil, ErrNotEnoughSeats
	}

	// Group by row label.
	byRow := groupByRow(available)

	// Determine the set of row labels in sorted order (front to back).
	rowLabels := sortedRowLabels(byRow)

	// Compute the total column count across all seats to derive centre column.
	maxCol := 0
	for _, s := range available {
		if s.ColumnNumber > maxCol {
			maxCol = s.ColumnNumber
		}
	}
	centreCol := float64(maxCol+1) / 2.0

	// ── Row-based fast path ───────────────────────────────────────────────────

	type candidate struct {
		seatIDs []string
		score   float64
	}
	var best *candidate

	for rowIdx, rowLabel := range rowLabels {
		rowSeats := byRow[rowLabel]
		// Sort by column within the row.
		sort.Slice(rowSeats, func(i, j int) bool {
			return rowSeats[i].ColumnNumber < rowSeats[j].ColumnNumber
		})

		// Find all contiguous runs of length `quantity` within this row.
		limit := len(rowSeats) - quantity + 1
		if limit > maxWindowPerRow {
			limit = maxWindowPerRow
		}
		for i := 0; i < limit; i++ {
			// Check contiguity: each successive seat must be exactly +1 column.
			contiguous := true
			for j := 1; j < quantity; j++ {
				if rowSeats[i+j].ColumnNumber != rowSeats[i+j-1].ColumnNumber+1 {
					contiguous = false
					break
				}
			}
			if !contiguous {
				continue
			}

			// Score: front rows score higher (lower rowIdx = higher score).
			// Centre column proximity adds a fractional bonus.
			blockCentreCol := float64(rowSeats[i].ColumnNumber+rowSeats[i+quantity-1].ColumnNumber) / 2.0
			distFromCentre := math.Abs(blockCentreCol - centreCol)
			score := 1000.0 - float64(rowIdx)*10.0 - distFromCentre

			ids := make([]string, quantity)
			for j := 0; j < quantity; j++ {
				ids[j] = rowSeats[i+j].ID
			}
			c := &candidate{seatIDs: ids, score: score}
			if best == nil || c.score > best.score {
				best = c
			}
		}
	}

	if best != nil {
		return best.seatIDs, nil
	}

	// ── Cross-row fallback ────────────────────────────────────────────────────
	// No single row had a contiguous block of the requested size.
	// Pick the best individual seats greedily: front rows first, then
	// closest to centre within each row.

	type scoredSeat struct {
		id    string
		score float64
	}

	scored := make([]scoredSeat, 0, len(available))
	for rowIdx, rowLabel := range rowLabels {
		for _, s := range byRow[rowLabel] {
			distFromCentre := math.Abs(float64(s.ColumnNumber) - centreCol)
			score := 1000.0 - float64(rowIdx)*10.0 - distFromCentre
			scored = append(scored, scoredSeat{id: s.ID, score: score})
		}
	}

	sort.Slice(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	ids := make([]string, quantity)
	for i := 0; i < quantity; i++ {
		ids[i] = scored[i].id
	}
	return ids, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func groupByRow(seats []*repository.Seat) map[string][]*repository.Seat {
	m := make(map[string][]*repository.Seat)
	for _, s := range seats {
		m[s.RowLabel] = append(m[s.RowLabel], s)
	}
	return m
}

// sortedRowLabels returns row labels sorted lexicographically (A, B, C, …
// which maps to front-of-venue first for standard layouts).
func sortedRowLabels(byRow map[string][]*repository.Seat) []string {
	labels := make([]string, 0, len(byRow))
	for k := range byRow {
		labels = append(labels, k)
	}
	sort.Strings(labels)
	return labels
}
