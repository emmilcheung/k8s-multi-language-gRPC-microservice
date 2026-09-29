using QueueService.Queue;
using StackExchange.Redis;
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
        var ttl = await fx.Mux.GetDatabase().KeyTimeToLiveAsync($"q:{{{eid}}}:prequeue");
        Assert.NotNull(ttl);
        Assert.InRange(ttl!.Value.TotalSeconds, 1, 120);
    }

    // SR-17. FreezeLua touches cfg + prequeue and EnqueueLateLua touches latepos +
    // late in one script. On a Redis Cluster (or ElastiCache in cluster mode) a
    // script whose keys hash to different slots is refused with CROSSSLOT, so the
    // freeze never happens and no latecomer is ever given a position: the waiting
    // room stops admitting at exactly the moment an on-sale opens.
    //
    // The test Redis is standalone, where the client's own HashSlot returns -1 for
    // every key (so it would pass vacuously) and CLUSTER KEYSLOT is refused. KeySlot
    // below is the cluster spec's routing function instead, pinned to values taken
    // from a real cluster-enabled redis:7 so it cannot drift from the server's.
    private static int KeySlot(string key)
    {
        var open = key.IndexOf('{');
        if (open >= 0)
        {
            var close = key.IndexOf('}', open + 1);
            if (close > open + 1) key = key.Substring(open + 1, close - open - 1);
        }
        ushort crc = 0; // CRC16/XMODEM: poly 0x1021, init 0
        foreach (var b in System.Text.Encoding.UTF8.GetBytes(key))
        {
            crc ^= (ushort)(b << 8);
            for (var i = 0; i < 8; i++)
                crc = (crc & 0x8000) != 0 ? (ushort)((crc << 1) ^ 0x1021) : (ushort)(crc << 1);
        }
        return crc % 16384;
    }

    [Theory]
    [InlineData("somekey", 11058)]
    [InlineData("foo{hash_tag}", 2515)]
    [InlineData("q:E-abc:cfg", 3073)]      // the pre-SR-17 layout: cfg and prequeue
    [InlineData("q:E-abc:prequeue", 5656)] // in different slots -> CROSSSLOT
    [InlineData("q:{E-abc}:cfg", 8481)]
    [InlineData("q:{E-abc}:prequeue", 8481)]
    [InlineData("{}x", 10595)]             // empty tag: whole key is hashed
    [InlineData("a{}b{c}", 7353)]          // only the first '{' counts
    public void KeySlot_matches_a_real_cluster(string key, int slot)
        => Assert.Equal(slot, KeySlot(key));

    [Fact]
    public async Task All_keys_for_one_event_share_a_hash_slot()
    {
        var store = NewStore(out var eid);
        await store.SetConfigAsync(new EventConfig(eid, DateTimeOffset.UtcNow, 100, true, null));
        await store.EnqueuePreQueueAsync(eid, "a", 0.1, NoCap, Ttl);
        var frozen = await store.FreezePreQueueSizeAsync(eid);
        await store.EnqueueLateAsync(eid, "L1", frozen, Ttl);

        var server = fx.Mux.GetServer(fx.Mux.GetEndPoints()[0]);
        var keys = new List<RedisKey>();
        await foreach (var k in server.KeysAsync(pattern: $"*{eid}*")) keys.Add(k);

        Assert.Equal(4, keys.Count); // cfg, prequeue, late, latepos
        Assert.Single(keys.Select(k => KeySlot(k!)).Distinct());
    }

    [Fact]
    public async Task Concurrent_distinct_late_enqueues_are_contiguous_and_unique()
    {
        var store = NewStore(out var eid);
        const int n = 100;
        var positions = await Task.WhenAll(
            Enumerable.Range(0, n).Select(i => store.EnqueueLateAsync(eid, $"m{i}", 0, Ttl)));

        Assert.Equal(n, positions.Distinct().Count());                 // no collisions
        Assert.Equal(0, positions.Min());                              // contiguous from pqSize
        Assert.Equal(n - 1, positions.Max());                          // no gaps
    }

    [Fact]
    public async Task Concurrent_same_mid_late_enqueue_burns_no_sequence()
    {
        var store = NewStore(out var eid);
        var positions = await Task.WhenAll(
            Enumerable.Range(0, 50).Select(_ => store.EnqueueLateAsync(eid, "same", 10, Ttl)));

        Assert.All(positions, p => Assert.Equal(10, p));               // all identical
        var counter = (long)await fx.Mux.GetDatabase().StringGetAsync($"q:{{{eid}}}:late");
        Assert.Equal(1, counter);                                      // exactly one slot consumed
    }
}
