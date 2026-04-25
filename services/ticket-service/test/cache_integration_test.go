package integration_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/acme/ticket-service/internal/cache"
	"github.com/acme/ticket-service/internal/repository"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
	"go.uber.org/zap"
)

type countingRepo struct {
	repo          repository.TicketRepository
	findByIDCalls int
	findAllCalls  int
}

func (r *countingRepo) Create(ctx context.Context, t *repository.Ticket) error {
	return r.repo.Create(ctx, t)
}

func (r *countingRepo) FindByID(ctx context.Context, id string) (*repository.Ticket, error) {
	r.findByIDCalls++
	return r.repo.FindByID(ctx, id)
}

func (r *countingRepo) FindByIDs(ctx context.Context, ids []string) ([]*repository.Ticket, error) {
	return r.repo.FindByIDs(ctx, ids)
}

func (r *countingRepo) FindAll(ctx context.Context, p repository.PaginationParams) ([]*repository.Ticket, error) {
	r.findAllCalls++
	return r.repo.FindAll(ctx, p)
}

func (r *countingRepo) Update(ctx context.Context, t *repository.Ticket) error {
	return r.repo.Update(ctx, t)
}

func (r *countingRepo) ReserveTicket(ctx context.Context, ticketID, orderID string) error {
	return r.repo.ReserveTicket(ctx, ticketID, orderID)
}

func (r *countingRepo) ReleaseTicket(ctx context.Context, ticketID string) error {
	return r.repo.ReleaseTicket(ctx, ticketID)
}

func (r *countingRepo) CreateReservation(ctx context.Context, res *repository.TicketReservation) error {
	return r.repo.CreateReservation(ctx, res)
}

func (r *countingRepo) FindReservationByID(ctx context.Context, reservationID string) (*repository.TicketReservation, error) {
	return r.repo.FindReservationByID(ctx, reservationID)
}

func (r *countingRepo) ReleaseReservation(ctx context.Context, reservationID string) error {
	return r.repo.ReleaseReservation(ctx, reservationID)
}

func (r *countingRepo) FinalizeReservation(ctx context.Context, reservationID, orderID string) error {
	return r.repo.FinalizeReservation(ctx, reservationID, orderID)
}

func (r *countingRepo) AttachSeatingPlan(ctx context.Context, ticketID, planID, userID, ticketType string, outbox *repository.TicketOutboxEvent) error {
	return r.repo.AttachSeatingPlan(ctx, ticketID, planID, userID, ticketType, outbox)
}

func (r *countingRepo) DetachSeatingPlan(ctx context.Context, ticketID, userID string, outbox *repository.TicketOutboxEvent) error {
	return r.repo.DetachSeatingPlan(ctx, ticketID, userID, outbox)
}

func (r *countingRepo) Ping(ctx context.Context) error {
	return r.repo.Ping(ctx)
}

func (r *countingRepo) Close(ctx context.Context) error {
	return r.repo.Close(ctx)
}

type failingCache struct {
	delegate cache.TicketCache
}

func (c *failingCache) GetTicket(context.Context, string) ([]byte, error) {
	return nil, errors.New("redis unavailable")
}
func (c *failingCache) SetTicket(ctx context.Context, id string, data []byte) error {
	return c.delegate.SetTicket(ctx, id, data)
}
func (c *failingCache) GetList(ctx context.Context) ([]byte, error) {
	return c.delegate.GetList(ctx)
}
func (c *failingCache) SetList(ctx context.Context, data []byte) error {
	return c.delegate.SetList(ctx, data)
}
func (c *failingCache) InvalidateTicket(ctx context.Context, id string) error {
	return c.delegate.InvalidateTicket(ctx, id)
}
func (c *failingCache) InvalidateList(ctx context.Context) error {
	return c.delegate.InvalidateList(ctx)
}

func setupCachingRepo(t *testing.T) (*repository.CachingTicketRepository, *countingRepo, *redis.Client, func()) {
	t.Helper()

	ctx := context.Background()
	mongoContainer, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err)

	mongoURI, err := mongoContainer.ConnectionString(ctx)
	require.NoError(t, err)

	redisContainer, err := tcredis.Run(ctx, "redis:7-alpine")
	require.NoError(t, err)

	redisAddr, err := redisContainer.ConnectionString(ctx)
	require.NoError(t, err)

	mongoRepo, err := repository.NewMongoTicketRepository(ctx, mongoURI, dbName(t.Name()))
	require.NoError(t, err)

	counting := &countingRepo{repo: mongoRepo}
	redisAddrValue := redisAddr
	if strings.HasPrefix(redisAddr, "redis://") {
		parsed, parseErr := redis.ParseURL(redisAddr)
		require.NoError(t, parseErr)
		redisAddrValue = parsed.Addr
	}

	redisClient := redis.NewClient(&redis.Options{Addr: redisAddrValue})
	redisCache := cache.NewRedisCache(redisClient)
	cacheRepo := repository.NewCachingTicketRepository(counting, redisCache, zap.NewNop())

	cleanup := func() {
		_ = mongoRepo.Close(ctx)
		_ = redisClient.Close()
		_ = mongoContainer.Terminate(ctx)
		_ = redisContainer.Terminate(ctx)
	}

	return cacheRepo, counting, redisClient, cleanup
}

func seedTicket(t *testing.T, repo repository.TicketRepository, id, userID string) {
	t.Helper()
	err := repo.Create(context.Background(), &repository.Ticket{
		ID:     id,
		Title:  "Ticket " + id,
		Price:  "10.00",
		UserID: userID,
	})
	require.NoError(t, err)
}

func TestCachingRepo_FindByID_cache_miss_fetches_from_mongo_and_populates_cache(t *testing.T) {
	cacheRepo, counting, redisClient, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-1", "u-1")

	got, err := cacheRepo.FindByID(context.Background(), "t-1")
	require.NoError(t, err)
	assert.Equal(t, "t-1", got.ID)
	assert.Equal(t, 1, counting.findByIDCalls)

	data, err := redisClient.Get(context.Background(), "ticket-service:ticket:t-1").Result()
	require.NoError(t, err)
	assert.NotEmpty(t, data)
}

func TestCachingRepo_FindByID_cache_hit_does_not_call_mongo(t *testing.T) {
	cacheRepo, counting, _, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-2", "u-1")

	_, err := cacheRepo.FindByID(context.Background(), "t-2")
	require.NoError(t, err)
	assert.Equal(t, 1, counting.findByIDCalls)

	_, err = cacheRepo.FindByID(context.Background(), "t-2")
	require.NoError(t, err)
	assert.Equal(t, 1, counting.findByIDCalls)
}

func TestCachingRepo_FindAll_cache_miss_fetches_from_mongo_and_populates_cache(t *testing.T) {
	cacheRepo, counting, redisClient, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-3", "u-1")
	seedTicket(t, cacheRepo, "t-4", "u-2")

	got, err := cacheRepo.FindAll(context.Background(), repository.PaginationParams{})
	require.NoError(t, err)
	assert.Len(t, got, 2)
	assert.Equal(t, 1, counting.findAllCalls)

	data, err := redisClient.Get(context.Background(), "ticket-service:tickets:list").Result()
	require.NoError(t, err)
	assert.NotEmpty(t, data)
}

func TestCachingRepo_FindAll_cache_hit_does_not_call_mongo(t *testing.T) {
	cacheRepo, counting, _, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-5", "u-1")

	_, err := cacheRepo.FindAll(context.Background(), repository.PaginationParams{})
	require.NoError(t, err)
	assert.Equal(t, 1, counting.findAllCalls)

	_, err = cacheRepo.FindAll(context.Background(), repository.PaginationParams{})
	require.NoError(t, err)
	assert.Equal(t, 1, counting.findAllCalls)
}

func TestCachingRepo_Create_invalidates_list_cache(t *testing.T) {
	cacheRepo, _, redisClient, cleanup := setupCachingRepo(t)
	defer cleanup()

	err := redisClient.Set(context.Background(), "ticket-service:tickets:list", "cached", 0).Err()
	require.NoError(t, err)

	err = cacheRepo.Create(context.Background(), &repository.Ticket{ID: "t-6", Title: "T6", Price: "10.00", UserID: "u-1"})
	require.NoError(t, err)

	_, err = redisClient.Get(context.Background(), "ticket-service:tickets:list").Result()
	assert.Equal(t, redis.Nil, err)
}

func TestCachingRepo_Update_invalidates_ticket_and_list_cache(t *testing.T) {
	cacheRepo, _, redisClient, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-7", "u-1")
	_, err := cacheRepo.FindByID(context.Background(), "t-7")
	require.NoError(t, err)
	err = redisClient.Set(context.Background(), "ticket-service:tickets:list", "cached", 0).Err()
	require.NoError(t, err)

	ticket, err := cacheRepo.FindByID(context.Background(), "t-7")
	require.NoError(t, err)
	ticket.Title = "Updated"
	err = cacheRepo.Update(context.Background(), ticket)
	require.NoError(t, err)

	_, err = redisClient.Get(context.Background(), "ticket-service:ticket:t-7").Result()
	assert.Equal(t, redis.Nil, err)
	_, err = redisClient.Get(context.Background(), "ticket-service:tickets:list").Result()
	assert.Equal(t, redis.Nil, err)
}

func TestCachingRepo_ReserveTicket_invalidates_ticket_and_list_cache(t *testing.T) {
	cacheRepo, _, redisClient, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-8", "u-1")
	_, err := cacheRepo.FindByID(context.Background(), "t-8")
	require.NoError(t, err)
	err = redisClient.Set(context.Background(), "ticket-service:tickets:list", "cached", 0).Err()
	require.NoError(t, err)

	err = cacheRepo.ReserveTicket(context.Background(), "t-8", "o-1")
	require.NoError(t, err)

	_, err = redisClient.Get(context.Background(), "ticket-service:ticket:t-8").Result()
	assert.Equal(t, redis.Nil, err)
	_, err = redisClient.Get(context.Background(), "ticket-service:tickets:list").Result()
	assert.Equal(t, redis.Nil, err)
}

func TestCachingRepo_ReleaseTicket_invalidates_ticket_and_list_cache(t *testing.T) {
	cacheRepo, _, redisClient, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-9", "u-1")
	err := cacheRepo.ReserveTicket(context.Background(), "t-9", "o-2")
	require.NoError(t, err)
	_, err = cacheRepo.FindByID(context.Background(), "t-9")
	require.NoError(t, err)
	err = redisClient.Set(context.Background(), "ticket-service:tickets:list", "cached", 0).Err()
	require.NoError(t, err)

	err = cacheRepo.ReleaseTicket(context.Background(), "t-9")
	require.NoError(t, err)

	_, err = redisClient.Get(context.Background(), "ticket-service:ticket:t-9").Result()
	assert.Equal(t, redis.Nil, err)
	_, err = redisClient.Get(context.Background(), "ticket-service:tickets:list").Result()
	assert.Equal(t, redis.Nil, err)
}

func TestCachingRepo_FindByID_redis_failure_falls_through_to_mongo(t *testing.T) {
	cacheRepo, counting, redisClient, cleanup := setupCachingRepo(t)
	defer cleanup()

	seedTicket(t, cacheRepo, "t-10", "u-1")

	failCache := &failingCache{delegate: cache.NewRedisCache(redisClient)}
	repoWithFailingCache := repository.NewCachingTicketRepository(counting, failCache, zap.NewNop())

	got, err := repoWithFailingCache.FindByID(context.Background(), "t-10")
	require.NoError(t, err)
	assert.Equal(t, "t-10", got.ID)
	assert.GreaterOrEqual(t, counting.findByIDCalls, 1)
}
