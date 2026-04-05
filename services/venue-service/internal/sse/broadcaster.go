// Package sse implements the real-time seat-availability broadcaster for
// venue-service using Server-Sent Events (SSE).
//
// Architecture:
//   - Each seating plan has its own fan-out channel managed by Broadcaster.
//   - Seat state changes are published via Publish(planID, payload).
//   - Clients subscribe via Subscribe(planID) and receive a channel of
//     string messages; they unsubscribe via Unsubscribe.
//   - If a Redis client is configured, the broadcaster also subscribes to the
//     Redis pub/sub channel `venue:{planId}:changes` so changes published by
//     other service instances are propagated to local SSE clients.
//   - A heartbeat goroutine emits a ping event every HeartbeatInterval to
//     keep connections alive through proxies and load balancers.
package sse

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// HeartbeatInterval is the period between heartbeat events sent to all clients.
const HeartbeatInterval = 15 * time.Second

// heartbeatPayload is sent as a comment-style SSE event to keep connections alive.
const heartbeatPayload = ": heartbeat\n\n"

// Client represents a single SSE subscriber for a seating plan.
type Client struct {
	PlanID  string
	MsgChan chan string
}

// Broadcaster manages per-plan fan-out of seat state change events to SSE clients.
type Broadcaster struct {
	mu      sync.RWMutex
	clients map[string]map[*Client]struct{} // planID → set of clients

	redis *redis.Client
	log   *zap.Logger

	// redisSubs tracks active Redis pub/sub subscriptions keyed by planID.
	redisSubsMu sync.Mutex
	redisSubs   map[string]context.CancelFunc
}

// NewBroadcaster creates a new Broadcaster. redisClient may be nil; in that
// case only in-process fan-out is performed.
func NewBroadcaster(redisClient *redis.Client, log *zap.Logger) *Broadcaster {
	return &Broadcaster{
		clients:   make(map[string]map[*Client]struct{}),
		redis:     redisClient,
		log:       log,
		redisSubs: make(map[string]context.CancelFunc),
	}
}

// Subscribe registers a new SSE client for the given planID and returns a
// Client whose MsgChan will receive published messages.
// The caller is responsible for calling Unsubscribe when the client disconnects.
func (b *Broadcaster) Subscribe(planID string) *Client {
	c := &Client{
		PlanID:  planID,
		MsgChan: make(chan string, 64),
	}

	b.mu.Lock()
	if b.clients[planID] == nil {
		b.clients[planID] = make(map[*Client]struct{})
	}
	b.clients[planID][c] = struct{}{}
	b.mu.Unlock()

	// Ensure a Redis subscription exists for this plan (no-op if already running).
	if b.redis != nil {
		b.ensureRedisSub(planID)
	}

	return c
}

// Unsubscribe removes a client from the fan-out set and closes its channel.
func (b *Broadcaster) Unsubscribe(c *Client) {
	b.mu.Lock()
	if planClients, ok := b.clients[c.PlanID]; ok {
		delete(planClients, c)
		if len(planClients) == 0 {
			delete(b.clients, c.PlanID)
			// Cancel the Redis subscription for this plan when the last client leaves.
			if b.redis != nil {
				b.cancelRedisSub(c.PlanID)
			}
		}
	}
	b.mu.Unlock()
	close(c.MsgChan)
}

// Publish broadcasts payload to all SSE clients subscribed to planID.
// This is the in-process publish path (called directly by hold manager / gRPC
// handlers on the same instance). The Redis pub/sub path calls this
// indirectly via the Redis subscription goroutine.
func (b *Broadcaster) Publish(planID, payload string) {
	b.mu.RLock()
	planClients := b.clients[planID]
	b.mu.RUnlock()

	for c := range planClients {
		select {
		case c.MsgChan <- payload:
		default:
			// Client channel is full — drop the message rather than block.
			b.log.Warn("SSE client channel full, dropping message",
				zap.String("planId", planID))
		}
	}
}

// StartHeartbeat runs a goroutine that sends a heartbeat ping to all connected
// clients every HeartbeatInterval. It stops when ctx is cancelled.
func (b *Broadcaster) StartHeartbeat(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				b.mu.RLock()
				for planID := range b.clients {
					for c := range b.clients[planID] {
						select {
						case c.MsgChan <- heartbeatPayload:
						default:
						}
					}
				}
				b.mu.RUnlock()
			}
		}
	}()
}

// ── Redis pub/sub ─────────────────────────────────────────────────────────────

func changesKey(planID string) string {
	return fmt.Sprintf("venue:{%s}:changes", planID)
}

// ensureRedisSub starts a Redis subscription goroutine for planID if one is
// not already running.
func (b *Broadcaster) ensureRedisSub(planID string) {
	b.redisSubsMu.Lock()
	defer b.redisSubsMu.Unlock()

	if _, ok := b.redisSubs[planID]; ok {
		return // already subscribed
	}

	ctx, cancel := context.WithCancel(context.Background())
	b.redisSubs[planID] = cancel

	go b.runRedisSub(ctx, planID)
}

func (b *Broadcaster) cancelRedisSub(planID string) {
	b.redisSubsMu.Lock()
	defer b.redisSubsMu.Unlock()

	if cancel, ok := b.redisSubs[planID]; ok {
		cancel()
		delete(b.redisSubs, planID)
	}
}

func (b *Broadcaster) runRedisSub(ctx context.Context, planID string) {
	channel := changesKey(planID)
	pubsub := b.redis.Subscribe(ctx, channel)
	defer pubsub.Close() //nolint:errcheck

	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			// Forward the Redis message to in-process subscribers.
			// Format as an SSE data frame.
			ssePayload := fmt.Sprintf("data: %s\n\n", msg.Payload)
			b.Publish(planID, ssePayload)
		}
	}
}
