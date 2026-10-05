using Microsoft.Extensions.Time.Testing;
using QueueService.Queue;
using StackExchange.Redis;
using Xunit;

/// Operator controls change how fast people are let in. None of them may make
/// serving jump: a jump up lets a burst through, a drop un-admits people who
/// were already told to go.
[Collection("redis")]
public class AdmissionControlTests(RedisFixture fx)
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);

    private async Task<(EventAdmin admin, QueueStore store, FakeTimeProvider clock, string eid)> New(double rate = 100)
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var store = new QueueStore(fx.Mux);
        await store.SetConfigAsync(new EventConfig(eid, T0, rate, true, null));
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        return (new EventAdmin(store, clock), store, clock, eid);
    }

    private static async Task<long> ServingNow(QueueStore store, FakeTimeProvider clock, string eid)
        => (await store.GetConfigAsync(eid))!.ServingAt(clock.GetUtcNow());

    [Fact]
    public async Task Config_round_trips_the_rebase_and_flags()
    {
        var (_, store, _, eid) = await New();
        await store.SetConfigAsync(new EventConfig(eid, T0, 5, true, null,
            ServingBase: 70, TBase: T0.AddSeconds(3), SoldOut: true, Paused: true));
        var cfg = (await store.GetConfigAsync(eid))!;
        Assert.Equal(70, cfg.ServingBase);
        Assert.Equal(T0.AddSeconds(3), cfg.TBase);
        Assert.True(cfg.SoldOut);
        Assert.True(cfg.Paused);
    }

    [Fact]
    public async Task A_config_written_by_hand_without_the_new_fields_still_works()
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        await fx.Mux.GetDatabase().HashSetAsync($"q:{{{eid}}}:cfg", new HashEntry[]
        {
            new("t0", T0.ToUnixTimeMilliseconds()), new("rate", 100), new("armed", 1),
        });
        var cfg = (await new QueueStore(fx.Mux).GetConfigAsync(eid))!;

        Assert.False(cfg.SoldOut);
        Assert.False(cfg.Paused);
        Assert.Equal(1000, cfg.ServingAt(T0.AddSeconds(10)));
    }

    [Fact]
    public async Task Changing_the_rate_mid_sale_never_makes_serving_jump_or_fall()
    {
        var (admin, store, clock, eid) = await New(rate: 100);
        var last = await ServingNow(store, clock, eid);
        Assert.Equal(1000, last);

        foreach (var newRate in new[] { 400.0, 20.0, 300.0 })
        {
            Assert.True(await admin.SetRateAsync(eid, newRate));
            Assert.Equal(last, await ServingNow(store, clock, eid)); // continuous at the change
            for (var i = 0; i < 5; i++)
            {
                clock.Advance(TimeSpan.FromSeconds(1.7));
                var now = await ServingNow(store, clock, eid);
                Assert.True(now >= last);
                last = now;
            }
        }
        // 1000 + 400*8.5 + 20*8.5 + 300*8.5 admitted, floor of each segment's carry.
        Assert.InRange(last, 7100, 7125);
    }

    [Fact]
    public async Task Pausing_freezes_serving_and_resuming_continues_without_a_burst()
    {
        var (admin, store, clock, eid) = await New(rate: 100);

        Assert.True(await admin.SetPausedAsync(eid, true));
        var frozen = await ServingNow(store, clock, eid);
        Assert.Equal(1000, frozen);
        clock.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal(frozen, await ServingNow(store, clock, eid)); // nothing admitted while paused

        Assert.True(await admin.SetPausedAsync(eid, false));
        Assert.Equal(frozen, await ServingNow(store, clock, eid)); // no catch-up for the 5 minutes
        clock.Advance(TimeSpan.FromSeconds(2));
        Assert.Equal(frozen + 200, await ServingNow(store, clock, eid));
    }

    [Fact]
    public async Task Resuming_when_not_paused_changes_nothing()
    {
        var (admin, store, clock, eid) = await New(rate: 100);
        await admin.SetPausedAsync(eid, false);
        Assert.Equal(1000, await ServingNow(store, clock, eid));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(1100, await ServingNow(store, clock, eid));
    }

    [Fact]
    public async Task Resuming_before_the_sale_opens_does_not_bank_the_wait_as_admissions()
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var store = new QueueStore(fx.Mux);
        await store.SetConfigAsync(new EventConfig(eid, T0, 100, true, null));
        var clock = new FakeTimeProvider(T0.AddMinutes(-10));
        var admin = new EventAdmin(store, clock);

        await admin.SetPausedAsync(eid, true);
        await admin.SetPausedAsync(eid, false);
        clock.SetUtcNow(T0.AddSeconds(1));

        Assert.Equal(100, await ServingNow(store, clock, eid));
    }

    [Fact]
    public async Task Sold_out_is_a_flag_that_leaves_serving_alone()
    {
        var (admin, store, clock, eid) = await New(rate: 100);
        Assert.True(await admin.SetSoldOutAsync(eid, true));
        var cfg = (await store.GetConfigAsync(eid))!;
        Assert.True(cfg.SoldOut);
        Assert.Equal(1000, cfg.ServingAt(clock.GetUtcNow()));
        Assert.True(await admin.SetSoldOutAsync(eid, false));
        Assert.False((await store.GetConfigAsync(eid))!.SoldOut);
    }

    [Fact]
    public async Task Controls_report_an_unknown_event_without_creating_it()
    {
        var (admin, _, _, _) = await New();
        Assert.False(await admin.SetRateAsync("no-such-event", 5));
        Assert.False(await admin.SetPausedAsync("no-such-event", true));
        Assert.False(await admin.SetSoldOutAsync("no-such-event", true));
        Assert.False(await fx.Mux.GetDatabase().KeyExistsAsync("q:{no-such-event}:cfg"));
    }

    // Many pods see the same venue signal; only the first may rebase, or serving would
    // be re-based again and again (and could be rewound by a stale writer).
    [Fact]
    public async Task Concurrent_venue_freezes_rebase_exactly_once_and_resume_does_not_rewind()
    {
        var (_, store, clock, eid) = await New(rate: 100);
        var now = clock.GetUtcNow();

        var results = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => store.SetVenuePausedAsync(eid, true, now)));
        Assert.Single(results, r => r);
        var cfg = (await store.GetConfigAsync(eid))!;
        Assert.True(cfg.VenuePaused);
        Assert.Equal(1000, cfg.ServingBase);

        clock.Advance(TimeSpan.FromMinutes(3));
        Assert.False(await store.SetVenuePausedAsync(eid, true, clock.GetUtcNow())); // late pod: no-op
        Assert.Equal(1000, (await store.GetConfigAsync(eid))!.ServingAt(clock.GetUtcNow()));

        var resumes = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => store.SetVenuePausedAsync(eid, false, clock.GetUtcNow())));
        Assert.Single(resumes, r => r);
        Assert.Equal(1000, await ServingNow(store, clock, eid)); // no catch-up for the 3 minutes
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(1100, await ServingNow(store, clock, eid));
    }

    // Serving stays frozen while EITHER pause is on: ending one must not release the other.
    [Fact]
    public async Task Serving_stays_frozen_until_both_the_operator_and_venue_pauses_have_ended()
    {
        var (admin, store, clock, eid) = await New(rate: 100);

        await store.SetVenuePausedAsync(eid, true, clock.GetUtcNow());
        await admin.SetPausedAsync(eid, true);
        clock.Advance(TimeSpan.FromMinutes(1));
        await store.SetVenuePausedAsync(eid, false, clock.GetUtcNow()); // venue ends, operator still on
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(1000, await ServingNow(store, clock, eid));

        await admin.SetPausedAsync(eid, false);
        Assert.Equal(1000, await ServingNow(store, clock, eid));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(1100, await ServingNow(store, clock, eid));

        // And the other order: operator ends first while the venue is still on.
        await admin.SetPausedAsync(eid, true);
        await store.SetVenuePausedAsync(eid, true, clock.GetUtcNow());
        clock.Advance(TimeSpan.FromMinutes(1));
        await admin.SetPausedAsync(eid, false);
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(1100, await ServingNow(store, clock, eid));
        await store.SetVenuePausedAsync(eid, false, clock.GetUtcNow());
        Assert.Equal(1100, await ServingNow(store, clock, eid));
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(1200, await ServingNow(store, clock, eid));
    }

    [Fact]
    public async Task A_rate_change_during_a_venue_pause_does_not_unfreeze_serving()
    {
        var (admin, store, clock, eid) = await New(rate: 100);
        await store.SetVenuePausedAsync(eid, true, clock.GetUtcNow());
        clock.Advance(TimeSpan.FromSeconds(30));
        await admin.SetRateAsync(eid, 500);
        clock.Advance(TimeSpan.FromSeconds(30));
        Assert.Equal(1000, await ServingNow(store, clock, eid));
        await store.SetVenuePausedAsync(eid, false, clock.GetUtcNow());
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(1500, await ServingNow(store, clock, eid)); // new rate applies from the resume
    }

    // The script's maths must agree with EventConfig.ServingAt, or a rebase would jump.
    [Fact]
    public async Task The_script_rebase_matches_the_c_sharp_serving_maths_including_before_t0()
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var store = new QueueStore(fx.Mux);
        await store.SetConfigAsync(new EventConfig(eid, T0, 37.5, true, null, ServingBase: 12, TBase: T0.AddSeconds(4)));
        var clock = new FakeTimeProvider(T0.AddSeconds(-5));
        var admin = new EventAdmin(store, clock);

        foreach (var at in new[] { -5.0, 0, 3, 9.3, 20.123 })
        {
            clock.SetUtcNow(T0.AddSeconds(at));
            var before = (await store.GetConfigAsync(eid))!.ServingAt(clock.GetUtcNow());
            await admin.SetRateAsync(eid, 37.5);
            Assert.Equal(before, await ServingNow(store, clock, eid));
        }
    }

    [Fact]
    public async Task Concurrent_operator_changes_never_make_serving_jump_or_fall()
    {
        var (admin, store, clock, eid) = await New(rate: 100);
        var rates = Enumerable.Range(1, 30).Select(i => (double)i * 10).ToArray();

        await Task.WhenAll(rates.Select(r => admin.SetRateAsync(eid, r)));
        await Task.WhenAll(Enumerable.Range(0, 10).Select(i => admin.SetPausedAsync(eid, i % 2 == 0)));
        await admin.SetPausedAsync(eid, false);

        Assert.Equal(1000, await ServingNow(store, clock, eid));
        Assert.Contains((await store.GetConfigAsync(eid))!.Rate, rates);
    }
}
