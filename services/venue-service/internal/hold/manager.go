// Package hold implements the Redis-backed seat hold hot path for venue-service.
//
// Architecture:
//
//	Redis is the hot path for hold state (low-latency reads, TTL enforcement).
//	PostgreSQL remains the durable source of truth.
//	On every successful Redis hold, the PostgreSQL seats table is also updated
//	so the two stores stay in sync.
//
// Redis key layout (all keys share hash tag {planId} → same cluster slot):
//
//	venue:{planId}:seats                  HASH  seatId → stateByte
//	venue:{planId}:hold:{seatId}          STRING hold metadata JSON (TTL = holdTtlSec)
//	venue:{planId}:user-holds:{userId}    SET   seatIds held by user (TTL = holdTtlSec)
//	venue:{planId}:changes                PUBSUB channel for SSE notifications
package hold

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/acme/venue-service/internal/repository"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// Errors returned by the hold manager (re-exported from repository for convenience).
var (
	ErrSeatNotAvailable  = repository.ErrSeatNotAvailable
	ErrSeatNotHeldByUser = repository.ErrSeatNotHeldByUser
	ErrPlanNotActive     = errors.New("seating plan is not active")
)

// HoldMetadata is stored as JSON in venue:{planId}:hold:{seatId}.
type HoldMetadata struct {
	UserID    string    `json:"userId"`
	SessionID string    `json:"sessionId"`
	HeldAt    time.Time `json:"heldAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// HoldResult is returned by HoldSeats.
type HoldResult struct {
	Held      []string  `json:"held"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// SeatEntry is a single entry in the AvailabilitySnapshot seat map.
type SeatEntry struct {
	Status    string `json:"status"`    // lowercase: "available", "held", "reserved", etc.
	SectionID string `json:"sectionId"` // section this seat belongs to
}

// AvailabilitySnapshot is the return type for GetAvailability.
type AvailabilitySnapshot struct {
	PlanID   string               `json:"planId"`
	SeatMap  map[string]SeatEntry `json:"seatMap"`
	Counts   map[string]int       `json:"counts"`
	CachedAt time.Time            `json:"cachedAt"`
}

// ExtendedSectionRepo extends SectionRepository with methods needed only
// by the hold Manager (listing sections and sweeping expired holds).
type ExtendedSectionRepo interface {
	repository.SectionRepository
	ListSectionsByPlan(ctx context.Context, planID string) ([]*repository.Section, error)
	SweepExpiredHolds(ctx context.Context) (int64, error)
}

// SeatEventPublisher is an optional in-process broadcaster used when Redis is
// not available. It receives the same JSON payloads that would otherwise be
// published to Redis pub/sub.
type SeatEventPublisher interface {
	Publish(planID, payload string)
}

// Manager coordinates the Redis + PostgreSQL hold hot path.
type Manager struct {
	redis       *redis.Client
	sectionRepo ExtendedSectionRepo
	planRepo    repository.PlanRepository
	log         *zap.Logger

	// broadcaster is used for in-process SSE fan-out when Redis is unavailable.
	// It may be nil.
	broadcaster SeatEventPublisher
}

// NewManager creates a new hold Manager.
// redisClient may be nil; in that case all operations fall through to PostgreSQL only.
func NewManager(
	redisClient *redis.Client,
	sectionRepo ExtendedSectionRepo,
	planRepo repository.PlanRepository,
	log *zap.Logger,
) *Manager {
	return &Manager{
		redis:       redisClient,
		sectionRepo: sectionRepo,
		planRepo:    planRepo,
		log:         log,
	}
}

// WithBroadcaster attaches an in-process SSE broadcaster to the Manager.
// When Redis is unavailable, changes are published directly to the broadcaster.
func (m *Manager) WithBroadcaster(b SeatEventPublisher) {
	m.broadcaster = b
}

// ── Key helpers ───────────────────────────────────────────────────────────────

func seatsHashKey(planID string) string {
	return fmt.Sprintf("venue:{%s}:seats", planID)
}

func holdMetaKey(planID, seatID string) string {
	return fmt.Sprintf("venue:{%s}:hold:%s", planID, seatID)
}

func userHoldsKey(planID, userID string) string {
	return fmt.Sprintf("venue:{%s}:user-holds:%s", planID, userID)
}

func changesKey(planID string) string {
	return fmt.Sprintf("venue:{%s}:changes", planID)
}

// ── Public API ────────────────────────────────────────────────────────────────

// HoldSeats attempts to hold seatIDs for userID on planID.
//
// Behaviour:
//  1. Load the plan to get holdTtlSec and validate it is active.
//  2. If Redis is available: run Lua hold script for atomic cluster-safe hold.
//  3. Mirror the hold into PostgreSQL (seats table).
//  4. If Redis is unavailable: fall through to PostgreSQL-only hold path.
//
// Returns ErrSeatNotAvailable if any seat is already held/reserved/sold.
func (m *Manager) HoldSeats(ctx context.Context, planID, userID, sessionID string, seatIDs []string) (*HoldResult, error) {
	plan, err := m.planRepo.FindByID(ctx, planID)
	if err != nil {
		return nil, err
	}
	if plan.Status != repository.PlanStatusActive {
		return nil, ErrPlanNotActive
	}

	ttl := time.Duration(plan.HoldTTLSec) * time.Second
	if ttl <= 0 {
		ttl = 600 * time.Second
	}
	expiresAt := time.Now().UTC().Add(ttl)

	if m.redis != nil {
		if err := m.redisHold(ctx, planID, userID, sessionID, seatIDs, ttl, expiresAt); err != nil {
			if errors.Is(err, ErrSeatNotAvailable) {
				return nil, err
			}
			// Redis error — fall through to DB-only path.
			m.log.Warn("redis hold failed, falling through to DB-only hold",
				zap.Error(err), zap.String("planId", planID))
		} else {
			// Redis hold succeeded — mirror into PostgreSQL.
			if dbErr := m.sectionRepo.HoldSeats(ctx, seatIDs, userID, expiresAt); dbErr != nil {
				// Roll back the Redis hold so the two stores stay consistent.
				if rollbackErr := m.redisReleaseHold(ctx, planID, userID, seatIDs); rollbackErr != nil {
					m.log.Error("failed to rollback redis hold after DB error",
						zap.Error(rollbackErr), zap.String("planId", planID))
				}
				return nil, dbErr
			}
			m.publishChange(ctx, planID, "hold", seatIDs)
			return &HoldResult{Held: seatIDs, ExpiresAt: expiresAt}, nil
		}
	}

	// PostgreSQL-only hold (Redis unavailable or Redis path fell through).
	if err := m.sectionRepo.HoldSeats(ctx, seatIDs, userID, expiresAt); err != nil {
		return nil, err
	}
	return &HoldResult{Held: seatIDs, ExpiresAt: expiresAt}, nil
}

// ReleaseHold releases seats held by userID.
// Idempotent: releasing seats not held by the user is a no-op.
func (m *Manager) ReleaseHold(ctx context.Context, planID, userID string, seatIDs []string) error {
	if m.redis != nil {
		if err := m.redisReleaseHold(ctx, planID, userID, seatIDs); err != nil {
			m.log.Warn("redis release failed, falling through to DB-only release",
				zap.Error(err), zap.String("planId", planID))
		}
	}
	if err := m.sectionRepo.ReleaseHold(ctx, seatIDs, userID); err != nil {
		return err
	}
	m.publishChange(ctx, planID, "release", seatIDs)
	return nil
}

// GetAvailability returns the availability snapshot for a plan by merging
// live Redis state (if available) with the PostgreSQL seats table.
func (m *Manager) GetAvailability(ctx context.Context, planID string) (*AvailabilitySnapshot, error) {
	// Validate plan exists.
	if _, err := m.planRepo.FindByID(ctx, planID); err != nil {
		return nil, err
	}

	sections, err := m.sectionRepo.ListSectionsByPlan(ctx, planID)
	if err != nil {
		return nil, err
	}

	snap := &AvailabilitySnapshot{
		PlanID:   planID,
		SeatMap:  make(map[string]SeatEntry),
		Counts:   make(map[string]int),
		CachedAt: time.Now().UTC(),
	}

	for _, sec := range sections {
		seats, sErr := m.sectionRepo.FindSeatsBySection(ctx, sec.ID)
		if sErr != nil {
			return nil, sErr
		}

		for _, seat := range seats {
			status := strings.ToLower(string(seat.Status))

			// If Redis is available and the seat appears HELD in PostgreSQL,
			// check whether the hold TTL has already expired in Redis.
			// If the Redis hold key is gone but PostgreSQL still shows HELD,
			// report the seat as AVAILABLE (lazy cleanup).
			if m.redis != nil && seat.Status == repository.SeatStatusHeld {
				metaKey := holdMetaKey(planID, seat.ID)
				exists, rErr := m.redis.Exists(ctx, metaKey).Result()
				if rErr == nil && exists == 0 {
					status = strings.ToLower(string(repository.SeatStatusAvailable))
				}
			}

			snap.SeatMap[seat.ID] = SeatEntry{Status: status, SectionID: sec.ID}
			snap.Counts[status]++
		}
	}

	return snap, nil
}

// SweepExpiredHolds releases PostgreSQL held seats whose held_until has passed.
// Called periodically by the Sweeper goroutine.
func (m *Manager) SweepExpiredHolds(ctx context.Context) (int64, error) {
	return m.sectionRepo.SweepExpiredHolds(ctx)
}

// ── Redis Lua scripts ─────────────────────────────────────────────────────────

// luaHold atomically holds a batch of seats.
//
// KEYS[1]: seatsHash  (venue:{planId}:seats)
// ARGV[1]: userID
// ARGV[2]: sessionID
// ARGV[3]: heldAt ISO8601
// ARGV[4]: expiresAt ISO8601
// ARGV[5]: ttlSec (integer string)
// ARGV[6..N]: pairs of (seatId, holdMetaKey)
//
// Returns "ok" on success or "conflict:<seatId>" if any seat is not AVAILABLE.
var luaHold = redis.NewScript(`
local seatsHash = KEYS[1]
local userId    = ARGV[1]
local sessionId = ARGV[2]
local heldAt    = ARGV[3]
local expiresAt = ARGV[4]
local ttlSec    = tonumber(ARGV[5])
local meta = '{"userId":"' .. userId .. '","sessionId":"' .. sessionId .. '","heldAt":"' .. heldAt .. '","expiresAt":"' .. expiresAt .. '"}'

local argLen = #ARGV
local n = (argLen - 5) / 2

-- Phase 1: validate all seats are AVAILABLE (field absent or '0')
for i = 1, n do
    local seatId = ARGV[5 + (i-1)*2 + 1]
    local state  = redis.call('HGET', seatsHash, seatId)
    if state ~= false and state ~= '0' then
        return 'conflict:' .. seatId
    end
end

-- Phase 2: apply hold
for i = 1, n do
    local seatId  = ARGV[5 + (i-1)*2 + 1]
    local metaKey = ARGV[5 + (i-1)*2 + 2]
    redis.call('HSET', seatsHash, seatId, '1')
    redis.call('SET', metaKey, meta, 'EX', ttlSec)
end

return 'ok'
`)

// luaRelease atomically releases held seats back to AVAILABLE.
//
// KEYS[1]: seatsHash
// ARGV[1]: userID
// ARGV[2..N]: pairs of (seatId, holdMetaKey)
//
// Seats whose hold metadata belongs to a different user are skipped.
var luaRelease = redis.NewScript(`
local seatsHash = KEYS[1]
local userId    = ARGV[1]

local argLen = #ARGV
local n = (argLen - 1) / 2

for i = 1, n do
    local seatId  = ARGV[1 + (i-1)*2 + 1]
    local metaKey = ARGV[1 + (i-1)*2 + 2]
    local raw = redis.call('GET', metaKey)
    if raw ~= false then
        if string.find(raw, '"userId":"' .. userId .. '"', 1, true) then
            redis.call('HSET', seatsHash, seatId, '0')
            redis.call('DEL', metaKey)
        end
    else
        -- Hold TTL already expired — safe to mark available
        redis.call('HSET', seatsHash, seatId, '0')
    end
end
return 'ok'
`)

// ── internal helpers ──────────────────────────────────────────────────────────

func (m *Manager) redisHold(
	ctx context.Context,
	planID, userID, sessionID string,
	seatIDs []string,
	ttl time.Duration,
	expiresAt time.Time,
) error {
	now := time.Now().UTC()
	heldAt := now.Format(time.RFC3339)
	expiresAtStr := expiresAt.Format(time.RFC3339)
	ttlSec := int64(ttl.Seconds())

	keys := []string{seatsHashKey(planID)}
	args := []interface{}{
		userID,
		sessionID,
		heldAt,
		expiresAtStr,
		fmt.Sprintf("%d", ttlSec),
	}
	for _, id := range seatIDs {
		args = append(args, id, holdMetaKey(planID, id))
	}

	result, err := luaHold.Run(ctx, m.redis, keys, args...).Text()
	if err != nil {
		return fmt.Errorf("redis hold script error: %w", err)
	}
	if result != "ok" {
		// result is "conflict:<seatId>"
		return ErrSeatNotAvailable
	}

	// Maintain user-holds set (advisory, non-fatal on error).
	userHolds := userHoldsKey(planID, userID)
	pipe := m.redis.Pipeline()
	for _, id := range seatIDs {
		pipe.SAdd(ctx, userHolds, id)
	}
	pipe.Expire(ctx, userHolds, ttl)
	if _, pipeErr := pipe.Exec(ctx); pipeErr != nil {
		m.log.Warn("failed to update user-holds set", zap.Error(pipeErr))
	}

	return nil
}

func (m *Manager) redisReleaseHold(ctx context.Context, planID, userID string, seatIDs []string) error {
	keys := []string{seatsHashKey(planID)}
	args := []interface{}{userID}
	for _, id := range seatIDs {
		args = append(args, id, holdMetaKey(planID, id))
	}

	result, err := luaRelease.Run(ctx, m.redis, keys, args...).Text()
	if err != nil {
		return fmt.Errorf("redis release script error: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("redis release unexpected result: %s", result)
	}

	// Remove from user-holds set (advisory).
	userHolds := userHoldsKey(planID, userID)
	pipe := m.redis.Pipeline()
	for _, id := range seatIDs {
		pipe.SRem(ctx, userHolds, id)
	}
	if _, pipeErr := pipe.Exec(ctx); pipeErr != nil {
		m.log.Warn("failed to update user-holds set on release", zap.Error(pipeErr))
	}

	return nil
}

func (m *Manager) publishChange(ctx context.Context, planID, event string, seatIDs []string) {
	payload, err := json.Marshal(map[string]interface{}{
		"event":   event,
		"seatIds": seatIDs,
		"ts":      time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return
	}

	if m.redis != nil {
		if pubErr := m.redis.Publish(ctx, changesKey(planID), string(payload)).Err(); pubErr != nil {
			m.log.Warn("failed to publish seat change", zap.Error(pubErr), zap.String("planId", planID))
		}
		// Redis pub/sub takes care of delivering to SSE subscribers.
		return
	}

	// No Redis — publish directly to the in-process broadcaster if attached.
	if m.broadcaster != nil {
		ssePayload := fmt.Sprintf("data: %s\n\n", string(payload))
		m.broadcaster.Publish(planID, ssePayload)
	}
}
