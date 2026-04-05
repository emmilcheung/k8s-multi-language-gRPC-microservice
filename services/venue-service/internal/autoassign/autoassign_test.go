package autoassign_test

import (
	"testing"

	"github.com/acme/venue-service/internal/autoassign"
	"github.com/acme/venue-service/internal/repository"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// seat is a convenience constructor for test seats.
func seat(id, row string, col int) *repository.Seat {
	return &repository.Seat{
		ID:           id,
		RowLabel:     row,
		ColumnNumber: col,
		Status:       repository.SeatStatusAvailable,
		SeatLabel:    row + itoa(col),
	}
}

// seatHeld creates a HELD seat (should be ignored by FindBestBlock).
func seatHeld(id, row string, col int) *repository.Seat {
	s := seat(id, row, col)
	s.Status = repository.SeatStatusHeld
	return s
}

// itoa converts an int to its decimal string representation.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	b := make([]byte, 0, 4)
	for n > 0 {
		b = append(b, byte('0'+n%10))
		n /= 10
	}
	// reverse
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// ── Basic cases ───────────────────────────────────────────────────────────────

func TestFindBestBlock_ReturnsError_WhenNotEnoughSeats(t *testing.T) {
	seats := []*repository.Seat{
		seat("s1", "A", 1),
		seat("s2", "A", 2),
	}
	_, err := autoassign.FindBestBlock(seats, 5)
	require.Error(t, err)
	assert.ErrorIs(t, err, autoassign.ErrNotEnoughSeats)
}

func TestFindBestBlock_ReturnsError_WhenQuantityIsZero(t *testing.T) {
	seats := []*repository.Seat{seat("s1", "A", 1)}
	_, err := autoassign.FindBestBlock(seats, 0)
	require.Error(t, err)
}

func TestFindBestBlock_ReturnsSingleSeat_WhenQuantityIsOne(t *testing.T) {
	seats := []*repository.Seat{
		seat("s1", "A", 1),
		seat("s2", "A", 2),
		seat("s3", "A", 3),
	}
	ids, err := autoassign.FindBestBlock(seats, 1)
	require.NoError(t, err)
	require.Len(t, ids, 1)
	// Should pick the centremost seat in the front row.
	assert.Equal(t, "s2", ids[0])
}

func TestFindBestBlock_ReturnsContiguousBlock_WhenAvailable(t *testing.T) {
	// 5 seats in a row: A1-A5; request 3 → should pick A2-A4 (centremost).
	seats := []*repository.Seat{
		seat("s1", "A", 1),
		seat("s2", "A", 2),
		seat("s3", "A", 3),
		seat("s4", "A", 4),
		seat("s5", "A", 5),
	}
	ids, err := autoassign.FindBestBlock(seats, 3)
	require.NoError(t, err)
	require.Len(t, ids, 3)
	// Centremost block of 3 in columns 1-5 is columns 2-4.
	assert.ElementsMatch(t, []string{"s2", "s3", "s4"}, ids)
}

func TestFindBestBlock_PrefersContiguousInFrontRow(t *testing.T) {
	// Row A has a gap (not contiguous for qty=3), row B has a full run.
	seats := []*repository.Seat{
		seat("a1", "A", 1),
		seat("a2", "A", 2),
		// gap at A3
		seat("a4", "A", 4),
		seat("b1", "B", 1),
		seat("b2", "B", 2),
		seat("b3", "B", 3),
	}
	ids, err := autoassign.FindBestBlock(seats, 3)
	require.NoError(t, err)
	require.Len(t, ids, 3)
	// B row has the only contiguous run of 3.
	assert.ElementsMatch(t, []string{"b1", "b2", "b3"}, ids)
}

func TestFindBestBlock_PreferesFrontRow_WhenBothHaveContiguousBlock(t *testing.T) {
	// Both rows A and B have a contiguous run of 2; row A should win.
	seats := []*repository.Seat{
		seat("a1", "A", 1),
		seat("a2", "A", 2),
		seat("b1", "B", 1),
		seat("b2", "B", 2),
	}
	ids, err := autoassign.FindBestBlock(seats, 2)
	require.NoError(t, err)
	require.Len(t, ids, 2)
	assert.ElementsMatch(t, []string{"a1", "a2"}, ids)
}

func TestFindBestBlock_CrossRowFallback_WhenNoRowHasEnoughContiguous(t *testing.T) {
	// Each row has only 1 available seat; need 3 → cross-row fallback.
	seats := []*repository.Seat{
		seat("a1", "A", 2), // centre of row A
		seat("b1", "B", 2),
		seat("c1", "C", 2),
	}
	ids, err := autoassign.FindBestBlock(seats, 3)
	require.NoError(t, err)
	require.Len(t, ids, 3)
	assert.ElementsMatch(t, []string{"a1", "b1", "c1"}, ids)
}

func TestFindBestBlock_IgnoresHeldSeats(t *testing.T) {
	seats := []*repository.Seat{
		seat("s1", "A", 1),
		seatHeld("s2", "A", 2), // HELD — must be excluded
		seat("s3", "A", 3),
	}
	// Only s1 and s3 are available; qty=2 but they are NOT contiguous.
	// Cross-row fallback should return both.
	ids, err := autoassign.FindBestBlock(seats, 2)
	require.NoError(t, err)
	require.Len(t, ids, 2)
	assert.ElementsMatch(t, []string{"s1", "s3"}, ids)
}

func TestFindBestBlock_PicksCentre_WhenMultipleContiguousOptionsExist(t *testing.T) {
	// Row with 6 seats: request 2. Centre is between col 3 and 4.
	// Blocks: (1,2),(2,3),(3,4),(4,5),(5,6). Centremost is (3,4).
	seats := []*repository.Seat{
		seat("s1", "A", 1),
		seat("s2", "A", 2),
		seat("s3", "A", 3),
		seat("s4", "A", 4),
		seat("s5", "A", 5),
		seat("s6", "A", 6),
	}
	ids, err := autoassign.FindBestBlock(seats, 2)
	require.NoError(t, err)
	require.Len(t, ids, 2)
	assert.ElementsMatch(t, []string{"s3", "s4"}, ids)
}

func TestFindBestBlock_ReturnsErrNotEnoughSeats_WhenAllSeatsAreHeld(t *testing.T) {
	seats := []*repository.Seat{
		seatHeld("s1", "A", 1),
		seatHeld("s2", "A", 2),
	}
	_, err := autoassign.FindBestBlock(seats, 1)
	require.Error(t, err)
	assert.ErrorIs(t, err, autoassign.ErrNotEnoughSeats)
}
