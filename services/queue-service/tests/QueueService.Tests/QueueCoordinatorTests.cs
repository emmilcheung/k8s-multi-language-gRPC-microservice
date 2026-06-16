using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Tokens;
using Xunit;

[Collection("redis")]
public class QueueCoordinatorTests(RedisFixture fx)
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);

    private (QueueCoordinator coord, FakeTimeProvider clock, string eid) New()
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var clock = new FakeTimeProvider(T0.AddMinutes(-5)); // start 5 min before sale
        var opts = Options.Create(new QueueOptions
        {
            HmacSecret = new string('k', 32), RedisConnection = "x",
            AdmissionTtlSeconds = 600, SlidingGraceSeconds = 60
        });
        var store = new QueueStore(fx.Mux);
        var tokens = new TokenService(opts.Value.HmacSecret);
        var coord = new QueueCoordinator(store, tokens, clock, opts);
        store.SetConfigAsync(new EventConfig(eid, T0, 100, true, null)).GetAwaiter().GetResult();
        return (coord, clock, eid);
    }

    [Fact]
    public async Task Enqueue_before_T0_is_pre_phase_with_no_frozen_position()
    {
        var (coord, _, eid) = New();
        var r = await coord.EnqueueAsync(eid, existing: null);
        Assert.Equal("pre", r.Phase);
        Assert.Null(r.Ticket.Pos);
        Assert.True(r.Ticket.R is >= 0 and < 1);
    }

    [Fact]
    public async Task Status_after_T0_freezes_position_into_ticket()
    {
        var (coord, clock, eid) = New();
        var enq = await coord.EnqueueAsync(eid, existing: null);   // pre-queue, no pos
        clock.SetUtcNow(T0.AddSeconds(1));                          // sale open
        var st = await coord.GetStatusAsync(eid, enq.Ticket);
        Assert.NotNull(st.Ticket.Pos);                             // frozen now
        Assert.Equal(0, st.Position);                              // sole member -> rank 0
        Assert.True(st.Admitted);                                  // serving(1s)=100 > 0
    }

    [Fact]
    public async Task Not_admitted_until_serving_passes_position()
    {
        var (coord, clock, eid) = New();
        var mine = await coord.EnqueueAsync(eid, existing: null);
        for (var i = 0; i < 500; i++)
            await coord.EnqueueAsync(eid, existing: null);

        clock.SetUtcNow(T0.AddMilliseconds(1)); // serving ~ 0
        var early = await coord.GetStatusAsync(eid, mine.Ticket);
        clock.SetUtcNow(T0.AddSeconds(10));      // serving = 1000 > any rank (<=500)
        var later = await coord.GetStatusAsync(eid, early.Ticket);

        Assert.True(later.Admitted);
        Assert.True(later.WaitSeconds == 0);
    }

    [Fact]
    public async Task Claim_returns_signed_token_only_when_admitted()
    {
        var (coord, clock, eid) = New();
        var enq = await coord.EnqueueAsync(eid, existing: null);
        clock.SetUtcNow(T0.AddSeconds(-1));
        var tooEarly = await coord.ClaimAsync(eid, enq.Ticket);
        Assert.False(tooEarly.Admitted);
        Assert.Null(tooEarly.Token);

        clock.SetUtcNow(T0.AddSeconds(1));
        var ok = await coord.ClaimAsync(eid, enq.Ticket);
        Assert.True(ok.Admitted);
        Assert.NotNull(ok.Token);
    }
}
