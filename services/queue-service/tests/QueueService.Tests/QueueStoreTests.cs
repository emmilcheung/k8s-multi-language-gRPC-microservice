using QueueService.Queue;
using Xunit;

[Collection("redis")]
public class QueueStoreTests(RedisFixture fx)
{
    private const int NoCap = int.MaxValue;
    private const int Ttl = 3600;

    private QueueStore NewStore(out string eid)
    {
        eid = "E-" + Guid.NewGuid().ToString("N"); // isolate keys per test
        return new QueueStore(fx.Mux);
    }

    [Fact]
    public async Task Config_round_trips()
    {
        var store = NewStore(out var eid);
        var t0 = new DateTimeOffset(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);
        await store.SetConfigAsync(new EventConfig(eid, t0, 100, true, null));

        var cfg = await store.GetConfigAsync(eid);
        Assert.NotNull(cfg);
        Assert.Equal(t0, cfg!.T0);
        Assert.Equal(100, cfg.Rate);
        Assert.True(cfg.Armed);
        Assert.Null(cfg.PreQueueSize);
    }

    [Fact]
    public async Task PreQueue_rank_reflects_random_score_order()
    {
        var store = NewStore(out var eid);
        await store.EnqueuePreQueueAsync(eid, "low", 0.10, NoCap, Ttl);
        await store.EnqueuePreQueueAsync(eid, "high", 0.90, NoCap, Ttl);
        await store.EnqueuePreQueueAsync(eid, "mid", 0.50, NoCap, Ttl);

        Assert.Equal(0, await store.RankInPreQueueAsync(eid, "low"));
        Assert.Equal(1, await store.RankInPreQueueAsync(eid, "mid"));
        Assert.Equal(2, await store.RankInPreQueueAsync(eid, "high"));
    }

    [Fact]
    public async Task Reenqueue_keeps_first_score()
    {
        var store = NewStore(out var eid);
        await store.EnqueuePreQueueAsync(eid, "m", 0.20, NoCap, Ttl);
        await store.EnqueuePreQueueAsync(eid, "m", 0.99, NoCap, Ttl); // must be ignored (NX)
        await store.EnqueuePreQueueAsync(eid, "other", 0.50, NoCap, Ttl);

        Assert.Equal(0, await store.RankInPreQueueAsync(eid, "m"));
    }

    [Fact]
    public async Task Freeze_size_is_idempotent_and_late_positions_follow_it()
    {
        var store = NewStore(out var eid);
        await store.EnqueuePreQueueAsync(eid, "a", 0.1, NoCap, Ttl);
        await store.EnqueuePreQueueAsync(eid, "b", 0.2, NoCap, Ttl);

        var frozen = await store.FreezePreQueueSizeAsync(eid);
        Assert.Equal(2, frozen);
        Assert.Equal(2, await store.FreezePreQueueSizeAsync(eid)); // idempotent

        Assert.Equal(2, await store.EnqueueLateAsync(eid, "L1", frozen, Ttl)); // first latecomer
        Assert.Equal(3, await store.EnqueueLateAsync(eid, "L2", frozen, Ttl));
        Assert.Equal(2, await store.EnqueueLateAsync(eid, "L1", frozen, Ttl)); // stable on repeat
    }

    [Fact]
    public async Task PreQueue_cap_rejects_members_beyond_max()
    {
        var store = NewStore(out var eid);
        Assert.True(await store.EnqueuePreQueueAsync(eid, "a", 0.1, maxSize: 2, ttlSeconds: Ttl));
        Assert.True(await store.EnqueuePreQueueAsync(eid, "b", 0.2, 2, Ttl));
        Assert.False(await store.EnqueuePreQueueAsync(eid, "c", 0.3, 2, Ttl)); // full -> rejected
        Assert.True(await store.EnqueuePreQueueAsync(eid, "a", 0.9, 2, Ttl));  // already in -> allowed
    }

    [Fact]
    public async Task Enqueue_sets_ttl_on_prequeue_key()
    {
        var store = NewStore(out var eid);
        await store.EnqueuePreQueueAsync(eid, "a", 0.1, NoCap, ttlSeconds: 120);
        var ttl = await fx.Mux.GetDatabase().KeyTimeToLiveAsync($"q:{eid}:prequeue");
        Assert.NotNull(ttl);
        Assert.InRange(ttl!.Value.TotalSeconds, 1, 120);
    }
}
