using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using QueueService.Options;
using QueueService.Queue;
using StackExchange.Redis;
using Xunit;

/// Counts config reads and can hold them open, to prove how many reach Redis.
public sealed class CountingStore(IConnectionMultiplexer mux) : QueueStore(mux)
{
    private int _reads;
    public int ConfigReads => Volatile.Read(ref _reads);
    public TaskCompletionSource? Gate { get; set; }
    public bool Fail { get; set; }

    public override async Task<EventConfig?> GetConfigAsync(string eid)
    {
        Interlocked.Increment(ref _reads);
        if (Gate is { } g) await g.Task;
        if (Fail) throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "redis is down");
        return await base.GetConfigAsync(eid);
    }
}

[Collection("redis")]
public class SnapshotCacheTests(RedisFixture fx)
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);

    private async Task<(EventSnapshotCache cache, CountingStore store, FakeTimeProvider clock, string eid)> New()
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var store = new CountingStore(fx.Mux);
        await store.SetConfigAsync(new EventConfig(eid, T0, 100, true, null));
        var clock = new FakeTimeProvider(T0);
        var cache = new EventSnapshotCache(store, clock, Options.Create(new QueueOptions()),
            new NoHttp(), NullLogger<EventSnapshotCache>.Instance);
        return (cache, store, clock, eid);
    }

    private sealed class NoHttp : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("venue polling is off");
    }

    // The serving poll is the hottest call of the sale; a hit must never touch Redis.
    [Fact]
    public async Task A_cache_hit_makes_no_redis_call_and_the_snapshot_refreshes_after_a_second()
    {
        var (cache, store, clock, eid) = await New();

        await cache.GetAsync(eid);
        for (var i = 0; i < 50; i++) await cache.GetAsync(eid);
        Assert.Equal(1, store.ConfigReads);

        clock.Advance(TimeSpan.FromMilliseconds(999));
        await cache.GetAsync(eid);
        Assert.Equal(1, store.ConfigReads);

        clock.Advance(TimeSpan.FromMilliseconds(2));
        await cache.GetAsync(eid);
        Assert.Equal(2, store.ConfigReads);
    }

    [Fact]
    public async Task Concurrent_misses_share_one_redis_read()
    {
        var (cache, store, _, eid) = await New();
        store.Gate = new TaskCompletionSource();

        var calls = Enumerable.Range(0, 20).Select(_ => cache.GetAsync(eid)).ToArray();
        store.Gate.SetResult();
        var snaps = await Task.WhenAll(calls);

        Assert.Equal(1, store.ConfigReads);
        Assert.All(snaps, s => Assert.Equal(100, s!.Config.Rate));
    }

    [Fact]
    public async Task An_unknown_event_is_cached_too_so_probing_ids_cannot_hammer_redis()
    {
        var (cache, store, _, _) = await New();
        for (var i = 0; i < 10; i++) Assert.Null(await cache.GetAsync("no-such-event"));
        Assert.Equal(1, store.ConfigReads);
    }

    // A Redis blip must not turn every waiting visitor's poll into a 500, but a snapshot
    // must not stand in for the real config indefinitely either.
    [Fact]
    public async Task A_redis_failure_serves_the_last_snapshot_within_ten_seconds_then_fails()
    {
        var (cache, store, clock, eid) = await New();
        var good = await cache.GetAsync(eid);
        store.Fail = true;

        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Same(good, await cache.GetAsync(eid));
        clock.Advance(TimeSpan.FromSeconds(5)); // exactly 10 s old: still inside the window
        Assert.Same(good, await cache.GetAsync(eid));

        clock.Advance(TimeSpan.FromMilliseconds(1));
        await Assert.ThrowsAsync<RedisConnectionException>(() => cache.GetAsync(eid));

        store.Fail = false; // recovery: a fresh read replaces the stale one
        Assert.NotSame(good, await cache.GetAsync(eid));
    }

    [Fact]
    public async Task A_redis_failure_with_no_earlier_snapshot_fails()
    {
        var (cache, store, _, eid) = await New();
        store.Fail = true;
        await Assert.ThrowsAsync<RedisConnectionException>(() => cache.GetAsync(eid));
    }

    [Fact]
    public async Task During_a_redis_failure_concurrent_callers_share_one_attempt_and_all_get_the_snapshot()
    {
        var (cache, store, clock, eid) = await New();
        await cache.GetAsync(eid);
        clock.Advance(TimeSpan.FromSeconds(2));
        store.Fail = true;
        store.Gate = new TaskCompletionSource();
        var reads = store.ConfigReads;

        var calls = Enumerable.Range(0, 20).Select(_ => cache.GetAsync(eid)).ToArray();
        store.Gate.SetResult();
        var snaps = await Task.WhenAll(calls);

        Assert.Equal(reads + 1, store.ConfigReads);
        Assert.All(snaps, s => Assert.NotNull(s));
    }

    // Callers must not wait out Redis's own timeout (seconds) while a usable snapshot exists.
    [Fact]
    public async Task With_a_usable_snapshot_a_hanging_redis_does_not_delay_callers()
    {
        var (cache, store, clock, eid) = await New();
        var good = await cache.GetAsync(eid);
        clock.Advance(TimeSpan.FromSeconds(2));
        store.Gate = new TaskCompletionSource(); // the refresh never completes

        var first = cache.GetAsync(eid);
        var more = Enumerable.Range(0, 10).Select(_ => cache.GetAsync(eid)).ToArray();
        var all = Task.WhenAll(more.Append(first));
        Assert.Same(all, await Task.WhenAny(all, Task.Delay(TimeSpan.FromSeconds(2))));
        Assert.All(await all, s => Assert.Same(good, s));
        Assert.Equal(2, store.ConfigReads); // still one refresh, shared
    }

    // After a failed refresh, retrying on every poll would hammer a Redis that is struggling.
    [Fact]
    public async Task After_a_failed_refresh_no_new_read_starts_within_the_backoff()
    {
        var (cache, store, clock, eid) = await New();
        await cache.GetAsync(eid);
        clock.Advance(TimeSpan.FromSeconds(2));
        store.Fail = true;
        await cache.GetAsync(eid);
        for (var i = 0; i < 100 && store.ConfigReads < 2; i++) await Task.Delay(10);
        await Task.Delay(50); // let the failure land
        var reads = store.ConfigReads;

        clock.Advance(TimeSpan.FromMilliseconds(500));
        for (var i = 0; i < 5; i++) await cache.GetAsync(eid);
        await Task.Delay(50);
        Assert.Equal(reads, store.ConfigReads);

        clock.Advance(TimeSpan.FromMilliseconds(600)); // backoff over
        await cache.GetAsync(eid);
        for (var i = 0; i < 100 && store.ConfigReads == reads; i++) await Task.Delay(10);
        Assert.Equal(reads + 1, store.ConfigReads);
    }

    private WebApplicationFactory<Program> Factory(CountingStore store, FakeTimeProvider clock) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Queue:HmacSecret", new string('k', 32));
            b.UseSetting("Queue:UserIdSigningKey", new string('s', 32));
            b.UseSetting("Queue:RedisConnection", "unused");
            b.ConfigureServices(s =>
            {
                s.RemoveAll(typeof(IConnectionMultiplexer));
                s.AddSingleton(fx.Mux);
                s.RemoveAll<QueueStore>();
                s.AddSingleton<QueueStore>(store);
                s.RemoveAll<TimeProvider>();
                s.AddSingleton<TimeProvider>(clock);
            });
        });

    [Fact]
    public async Task Serving_endpoint_answers_from_the_snapshot_with_short_public_cache()
    {
        var (_, store, clock, eid) = await New();
        await using var f = Factory(store, clock);
        var client = f.CreateClient();
        clock.Advance(TimeSpan.FromSeconds(10)); // 10 s after T0 at 100/s

        var first = await client.GetAsync($"/api/serving?e={eid}");
        var reads = store.ConfigReads;
        for (var i = 0; i < 20; i++) await client.GetAsync($"/api/serving?e={eid}");

        Assert.Equal(reads, store.ConfigReads); // hits: zero Redis calls
        Assert.Equal("public, max-age=2", first.Headers.CacheControl!.ToString());
        var body = await first.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1000, body.GetProperty("serving").GetInt64());
        Assert.Equal(100, body.GetProperty("rate").GetDouble());
        Assert.False(body.GetProperty("soldOut").GetBoolean());
        Assert.False(body.GetProperty("paused").GetBoolean());
    }

    [Fact]
    public async Task Status_and_serving_carry_the_flags_and_claim_is_refused_with_409()
    {
        var (_, store, clock, eid) = await New();
        await store.SetConfigAsync(new EventConfig(eid, T0, 100, true, null, SoldOut: true, Paused: true));
        await using var f = Factory(store, clock);
        var client = f.CreateClient();
        clock.Advance(TimeSpan.FromSeconds(10));

        await client.PostAsync($"/api/enqueue?e={eid}", null);
        var claim = await client.PostAsync($"/api/claim?e={eid}", null);
        var status = await (await client.GetAsync($"/api/status?e={eid}")).Content.ReadFromJsonAsync<JsonElement>();
        var serving = await (await client.GetAsync($"/api/serving?e={eid}")).Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.Conflict, claim.StatusCode);
        var body = await claim.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("soldOut").GetBoolean());
        Assert.True(body.GetProperty("paused").GetBoolean());
        Assert.False(string.IsNullOrEmpty(body.GetProperty("error").GetString()));
        foreach (var j in new[] { status, serving })
        {
            Assert.True(j.GetProperty("soldOut").GetBoolean());
            Assert.True(j.GetProperty("paused").GetBoolean());
        }
    }
}
