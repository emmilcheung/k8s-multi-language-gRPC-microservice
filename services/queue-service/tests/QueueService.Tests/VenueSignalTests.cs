using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using QueueService.Options;
using QueueService.Queue;
using Xunit;

/// The venue signal turns "no seats left" into paused (seats may come back) or sold
/// out (none held either), without ever slowing the serving poll.
[Collection("redis")]
public class VenueSignalTests(RedisFixture fx)
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);

    private sealed class StubVenue : HttpMessageHandler, IHttpClientFactory
    {
        public int Calls;
        public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Respond = null!;
        public string? LastUrl;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            LastUrl = r.RequestUri!.ToString();
            return Respond(r, ct);
        }
        public HttpClient CreateClient(string name) => new(this);
        public void Returns(HttpStatusCode code, string body = "") =>
            Respond = (_, _) => Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(body) });
        public void Availability(int available, int held) =>
            Returns(HttpStatusCode.OK, $"{{\"available\":{available},\"held\":{held}}}");
    }

    private async Task<(EventSnapshotCache cache, StubVenue venue, FakeTimeProvider clock, string eid)> New(
        string? url = "http://venue/internal/tickets/{eid}/availability", bool opPaused = false, bool opSoldOut = false)
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var store = new QueueStore(fx.Mux);
        await store.SetConfigAsync(new EventConfig(eid, T0, 100, true, null, SoldOut: opSoldOut, Paused: opPaused));
        var clock = new FakeTimeProvider(T0);
        var venue = new StubVenue();
        venue.Availability(10, 0);
        var cache = new EventSnapshotCache(store, clock,
            Options.Create(new QueueOptions { VenueAvailabilityUrl = url }), venue, NullLogger<EventSnapshotCache>.Instance);
        return (cache, venue, clock, eid);
    }

    // The poll runs in the background; step the clock past the refresh and read again.
    // The clock must not move while a refresh is still running: its rebase would use the
    // earlier instant and serving would read one step ahead. In production the clock and
    // the refresh are milliseconds apart, so only a loaded test machine can open that gap.
    private static async Task<EventSnapshot> Settled(EventSnapshotCache cache, FakeTimeProvider clock, string eid,
        Func<EventSnapshot, bool> done)
    {
        for (var i = 0; i < 200; i++)
        {
            clock.Advance(TimeSpan.FromMilliseconds(1100));
            var before = (await cache.GetAsync(eid))!; // an expired snapshot is answered as is while the refresh runs behind it
            var s = before;
            for (var wait = 0; wait < 50 && ReferenceEquals(s, before); wait++)
            {
                await Task.Delay(10);
                s = (await cache.GetAsync(eid))!; // same instant, so a finished refresh shows as a new snapshot
            }
            if (done(s)) return s;
        }
        throw new Xunit.Sdk.XunitException("venue signal never reached the snapshot");
    }

    [Fact]
    public async Task No_seats_available_but_some_held_pauses_because_they_may_come_back()
    {
        var (cache, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        var s = await Settled(cache, clock, eid, x => x.Paused);
        Assert.False(s.SoldOut);
        Assert.Contains($"/internal/tickets/{eid}/availability", venue.LastUrl);
    }

    [Fact]
    public async Task No_seats_available_and_none_held_is_sold_out()
    {
        var (cache, venue, clock, eid) = await New();
        venue.Availability(0, 0);
        var s = await Settled(cache, clock, eid, x => x.SoldOut);
        Assert.False(s.Paused);
    }

    [Fact]
    public async Task Seats_coming_back_clears_the_signal()
    {
        var (cache, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(cache, clock, eid, x => x.Paused);
        venue.Availability(2, 1);
        var s = await Settled(cache, clock, eid, x => !x.Paused);
        Assert.False(s.SoldOut);
    }

    [Fact]
    public async Task Operator_flags_are_or_ed_with_a_quiet_venue()
    {
        var (cache, _, clock, eid) = await New(opPaused: true, opSoldOut: true);
        var s = (await cache.GetAsync(eid))!;
        Assert.True(s.Paused);
        Assert.True(s.SoldOut);
        clock.Advance(TimeSpan.FromSeconds(30));
        Assert.True((await cache.GetAsync(eid))!.Paused);
    }

    [Fact]
    public async Task A_missing_seating_plan_means_no_signal()
    {
        var (cache, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(cache, clock, eid, x => x.Paused);
        venue.Returns(HttpStatusCode.NotFound);
        await Settled(cache, clock, eid, x => !x.Paused);
    }

    private static string CfgKey(string eid) => $"q:{{{eid}}}:cfg";
    private long VenueAtMs(string eid) => (long)fx.Mux.GetDatabase().HashGet(CfgKey(eid), "venueAt");
    private static readonly TimeSpan Lapse = TimeSpan.FromSeconds(30);

    // Nobody can tell a venue that went quiet from one that is still sold out, so
    // serving does not resume on a guess at once. But a flag nobody can clear would
    // freeze the sale for good, so it lapses once the venue has been silent for a
    // while: well past any signal's life, so a briefly slow venue never trips it.
    [Fact]
    public async Task A_venue_that_goes_quiet_keeps_the_pause_for_a_while_then_it_lapses()
    {
        var (cache, venue, clock, eid) = await New();
        clock.Advance(TimeSpan.FromSeconds(10));
        await cache.GetAsync(eid);
        venue.Availability(0, 3);
        var s = await Settled(cache, clock, eid, x => x.Paused);
        var frozen = s.Serving(clock.GetUtcNow());
        venue.Returns(HttpStatusCode.InternalServerError);
        var lastReading = clock.GetUtcNow();

        while (clock.GetUtcNow() - lastReading < TimeSpan.FromSeconds(25)) // past the signal's 10 s life
        {
            await Task.Delay(10);
            clock.Advance(TimeSpan.FromSeconds(1.1));
            var held = (await cache.GetAsync(eid))!;
            Assert.True(held.Paused);
            Assert.Equal(frozen, held.Serving(clock.GetUtcNow()));
        }
        Assert.True((await new QueueStore(fx.Mux).GetConfigAsync(eid))!.VenuePaused);

        var released = await Settled(cache, clock, eid, x => !x.Paused);
        Assert.False((await new QueueStore(fx.Mux).GetConfigAsync(eid))!.VenuePaused);
        // Serving resumes as of the lapse moment, not as of now: no jump, no rewind.
        var lapseAt = DateTimeOffset.FromUnixTimeMilliseconds(VenueAtMs(eid)) + Lapse;
        var expected = frozen + (long)Math.Floor(100 * (clock.GetUtcNow() - lapseAt).TotalSeconds);
        Assert.Equal(expected, released.Serving(clock.GetUtcNow()));
        Assert.True(released.Serving(clock.GetUtcNow()) >= frozen);
    }

    // The venue may still be sold out, so a flag set moments ago must not be undone
    // by a pod that merely has no reading.
    [Fact]
    public async Task A_pod_without_a_reading_does_not_clear_a_recent_venue_pause()
    {
        var (podA, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(podA, clock, eid, x => x.Paused);

        var podB = new EventSnapshotCache(new QueueStore(fx.Mux), clock,
            Options.Create(new QueueOptions()), new StubVenue(), NullLogger<EventSnapshotCache>.Instance);
        clock.Advance(TimeSpan.FromSeconds(20));
        Assert.True((await podB.GetAsync(eid))!.Paused);
        Assert.True((await new QueueStore(fx.Mux).GetConfigAsync(eid))!.VenuePaused);
    }

    // A pod that still hears "paused" keeps stamping the flag, so a pod that cannot
    // reach the venue never mistakes a live pause for an abandoned one.
    [Fact]
    public async Task A_pod_with_a_fresh_paused_reading_keeps_the_flag_from_lapsing_on_other_pods()
    {
        var (podA, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(podA, clock, eid, x => x.Paused);
        var deaf = new StubVenue();
        deaf.Returns(HttpStatusCode.InternalServerError);
        var podB = new EventSnapshotCache(new QueueStore(fx.Mux), clock,
            Options.Create(new QueueOptions { VenueAvailabilityUrl = "http://venue/{eid}" }), deaf,
            NullLogger<EventSnapshotCache>.Instance);

        var started = clock.GetUtcNow();
        while (clock.GetUtcNow() - started < TimeSpan.FromSeconds(90)) // three lapses
        {
            await Task.Delay(5);
            clock.Advance(TimeSpan.FromSeconds(1.1));
            await podA.GetAsync(eid);
            await Task.Delay(5);
            await podA.GetAsync(eid);
            Assert.True((await podB.GetAsync(eid))!.Paused);
            Assert.True((await new QueueStore(fx.Mux).GetConfigAsync(eid))!.VenuePaused);
        }
        Assert.True(clock.GetUtcNow() - DateTimeOffset.FromUnixTimeMilliseconds(VenueAtMs(eid)) < TimeSpan.FromSeconds(10));
    }

    // Removing the venue URL (or running without one) must not leave an old flag behind forever.
    [Fact]
    public async Task With_no_venue_url_a_flag_set_earlier_still_lapses()
    {
        var (podA, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(podA, clock, eid, x => x.Paused);

        var podB = new EventSnapshotCache(new QueueStore(fx.Mux), clock,
            Options.Create(new QueueOptions { VenueAvailabilityUrl = null }), new StubVenue(),
            NullLogger<EventSnapshotCache>.Instance);
        clock.Advance(TimeSpan.FromSeconds(35));
        await podB.GetAsync(eid);
        clock.Advance(TimeSpan.FromSeconds(2));
        await podB.GetAsync(eid);
        Assert.False((await new QueueStore(fx.Mux).GetConfigAsync(eid))!.VenuePaused);
    }

    // The operator's own pause outlives the venue flag lapsing.
    [Fact]
    public async Task A_lapsing_venue_flag_leaves_the_operator_pause_in_force()
    {
        var (podA, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(podA, clock, eid, x => x.Paused);
        var store = new QueueStore(fx.Mux);
        await store.AdminUpdateAsync(eid, "paused", 1, clock.GetUtcNow());

        var podB = new EventSnapshotCache(store, clock,
            Options.Create(new QueueOptions()), new StubVenue(), NullLogger<EventSnapshotCache>.Instance);
        clock.Advance(TimeSpan.FromSeconds(40));
        await podB.GetAsync(eid);
        clock.Advance(TimeSpan.FromSeconds(2));
        var s = (await podB.GetAsync(eid))!;
        Assert.False((await store.GetConfigAsync(eid))!.VenuePaused);
        Assert.True(s.Paused);
    }

    // A pod that just started has no venue reading. It must not undo the pause the
    // other pods set: that would let about a second of claims through on every scale-up.
    [Fact]
    public async Task A_new_pod_with_no_venue_reading_neither_unfreezes_nor_allows_claims()
    {
        var (podA, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(podA, clock, eid, x => x.Paused);

        var deaf = new StubVenue();
        deaf.Returns(HttpStatusCode.InternalServerError);
        var podB = new EventSnapshotCache(new QueueStore(fx.Mux), clock,
            Options.Create(new QueueOptions { VenueAvailabilityUrl = "http://venue/{eid}" }), deaf,
            NullLogger<EventSnapshotCache>.Instance);

        for (var i = 0; i < 5; i++)
        {
            var s = (await podB.GetAsync(eid))!;
            Assert.True(s.Paused);
            Assert.True((await new QueueStore(fx.Mux).GetConfigAsync(eid))!.VenuePaused);
            await Task.Delay(10);
            clock.Advance(TimeSpan.FromMilliseconds(1100));
        }
    }

    [Fact]
    public async Task A_fresh_missing_seating_plan_clears_the_flag_in_the_shared_config()
    {
        var (cache, venue, clock, eid) = await New();
        venue.Availability(0, 3);
        await Settled(cache, clock, eid, x => x.Paused);
        venue.Returns(HttpStatusCode.NotFound);
        await Settled(cache, clock, eid, x => !x.Paused);
        Assert.False((await new QueueStore(fx.Mux).GetConfigAsync(eid))!.VenuePaused);
    }

    [Fact]
    public async Task A_slow_venue_never_holds_up_the_snapshot_and_times_out()
    {
        var (cache, venue, clock, eid) = await New();
        venue.Respond = async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return null!; };

        var started = DateTime.UtcNow;
        var s = (await cache.GetAsync(eid))!;
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(2));
        Assert.False(s.Paused);

        clock.Advance(TimeSpan.FromMilliseconds(600)); // past the 500 ms limit: the poll is cancelled
        await Task.Delay(50);
        clock.Advance(TimeSpan.FromSeconds(2));
        await cache.GetAsync(eid);
        await Task.Delay(50);
        Assert.True(venue.Calls >= 2); // the stuck call was released, so a new poll could start
    }

    [Fact]
    public async Task The_venue_is_polled_at_most_every_two_seconds()
    {
        var (cache, venue, clock, eid) = await New();
        for (var i = 0; i < 20; i++)
        {
            clock.Advance(TimeSpan.FromMilliseconds(1100)); // refresh every step, 22 s in all
            await cache.GetAsync(eid);
            await Task.Delay(5);
        }
        Assert.InRange(venue.Calls, 8, 11);
    }

    [Fact]
    public async Task Without_a_venue_url_nothing_is_polled()
    {
        var (cache, venue, clock, eid) = await New(url: null);
        for (var i = 0; i < 5; i++) { clock.Advance(TimeSpan.FromSeconds(2)); await cache.GetAsync(eid); }
        await Task.Delay(50);
        Assert.Equal(0, venue.Calls);
    }

    // An expired snapshot is answered as is while the refresh runs behind it, so read again
    // until the refresh has landed: the caller then moves the clock only after it is done.
    private static long ServingOf(EventSnapshotCache cache, FakeTimeProvider clock, string eid)
    {
        var before = cache.GetAsync(eid).GetAwaiter().GetResult()!;
        var s = before;
        for (var wait = 0; wait < 50 && ReferenceEquals(s, before); wait++)
        {
            Thread.Sleep(10);
            s = cache.GetAsync(eid).GetAwaiter().GetResult()!;
        }
        return s.Serving(clock.GetUtcNow());
    }

    // While no seat can be claimed, letting serving climb means that when a hold lapses
    // everyone below serving can claim at once, out of order.
    [Theory]
    [InlineData(0, 3)] // all seats held: paused
    [InlineData(0, 0)] // nothing held either: sold out
    public async Task Serving_does_not_advance_during_a_venue_pause_and_does_not_jump_when_it_ends(int available, int held)
    {
        var (cache, venue, clock, eid) = await New();
        clock.Advance(TimeSpan.FromSeconds(10));
        await cache.GetAsync(eid);
        venue.Availability(available, held);
        var s = await Settled(cache, clock, eid, x => x.Paused || x.SoldOut);
        var frozen = s.Serving(clock.GetUtcNow());

        var last = frozen;
        for (var i = 0; i < 40; i++) // ~44 s of polling, well past the venue signal's 10 s life
        {
            await Task.Delay(10);
            clock.Advance(TimeSpan.FromMilliseconds(1100));
            var now = ServingOf(cache, clock, eid);
            Assert.Equal(frozen, now);
            last = now;
        }

        venue.Availability(5, 0);
        var after = await Settled(cache, clock, eid, x => !x.Paused && !x.SoldOut);
        Assert.Equal(last, after.Serving(clock.GetUtcNow())); // resume continues from the freeze: no catch-up burst
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(last + 100, ServingOf(cache, clock, eid));
    }

    [Fact]
    public async Task Two_pods_seeing_the_same_venue_pause_freeze_serving_at_the_same_count()
    {
        var (podA, venue, clock, eid) = await New();
        var podB = new EventSnapshotCache(new QueueStore(fx.Mux), clock,
            Options.Create(new QueueOptions { VenueAvailabilityUrl = "http://venue/{eid}" }), venue,
            NullLogger<EventSnapshotCache>.Instance);
        clock.Advance(TimeSpan.FromSeconds(10));
        venue.Availability(0, 3);

        await Settled(podA, clock, eid, x => x.Paused);
        var a = ServingOf(podA, clock, eid);
        await Settled(podB, clock, eid, x => x.Paused);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(a, ServingOf(podB, clock, eid)); // the second pod did not re-base the count upward
    }
}
