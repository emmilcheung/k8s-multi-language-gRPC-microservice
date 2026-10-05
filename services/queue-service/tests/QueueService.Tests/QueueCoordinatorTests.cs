using Microsoft.Extensions.Logging.Abstractions;
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
            AdmissionTtlSeconds = 900, SlidingGraceSeconds = 60
        });
        var store = new QueueStore(fx.Mux);
        var tokens = new TokenService(opts.Value.HmacSecret);
        var coord = new QueueCoordinator(store, new EventSnapshotCache(store, clock, opts, null!, NullLogger<EventSnapshotCache>.Instance), tokens, clock, opts);
        _tokens = tokens;
        store.SetConfigAsync(new EventConfig(eid, T0, 100, true, null)).GetAwaiter().GetResult();
        return (coord, clock, eid);
    }

    private TokenService _tokens = default!;

    // An admitted queue place and the admission token its claim returned.
    private async Task<(PreQueueTicket ticket, string token)> Admitted(QueueCoordinator coord, string eid)
    {
        var enq = await coord.EnqueueAsync(eid, existing: null);
        var claim = await coord.ClaimAsync(eid, enq.Ticket);
        Assert.True(claim.Admitted);
        return (claim.Ticket, claim.Token!);
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

    // The purchase pass is what Kong checks on every purchase write. It must name
    // the account that redeemed it, or one admission could be handed to any
    // number of accounts (bots sharing a queue place).
    [Fact]
    public async Task Redeem_mints_a_pass_bound_to_the_redeeming_account()
    {
        var (coord, clock, eid) = New();
        clock.SetUtcNow(T0.AddSeconds(1));
        var (_, token) = await Admitted(coord, eid);

        var r = await coord.RedeemAsync(token, "user-a");

        Assert.Equal(RedeemOutcome.Ok, r.Outcome);
        Assert.True(_tokens.TryVerify<AdmissionToken>(r.Pass!, out var pass));
        Assert.Equal("user-a", pass!.Sub);
        Assert.Equal(eid, pass.Eid);
        // A pass lives long enough for seat selection and checkout (15 minutes).
        Assert.Equal(clock.GetUtcNow().ToUnixTimeSeconds() + 900, pass.Exp);
    }

    // A refresh, a second tab or a retry after a network error re-sends the same
    // admission link; the buyer must keep their place, not get "already used".
    [Fact]
    public async Task Redeem_again_by_the_same_account_returns_the_same_pass()
    {
        var (coord, clock, eid) = New();
        clock.SetUtcNow(T0.AddSeconds(1));
        var (_, token) = await Admitted(coord, eid);

        var first = await coord.RedeemAsync(token, "user-a");
        var again = await coord.RedeemAsync(token, "user-a");

        Assert.Equal(RedeemOutcome.Ok, again.Outcome);
        Assert.Equal(first.Pass, again.Pass);
    }

    [Fact]
    public async Task Redeem_by_another_account_for_the_same_queue_place_is_refused()
    {
        var (coord, clock, eid) = New();
        clock.SetUtcNow(T0.AddSeconds(1));
        var (ticket, token) = await Admitted(coord, eid);
        await coord.RedeemAsync(token, "user-a");

        // Same token, and a fresh claim from the same queue place: both stay with user-a.
        var sameToken = await coord.RedeemAsync(token, "user-b");
        var freshClaim = await coord.ClaimAsync(eid, ticket);
        var freshToken = await coord.RedeemAsync(freshClaim.Token!, "user-b");

        Assert.Equal(RedeemOutcome.OtherAccount, sameToken.Outcome);
        Assert.Equal(RedeemOutcome.OtherAccount, freshToken.Outcome);
        Assert.Null(freshToken.Pass);
    }

    // One pass per account per event: queueing from a second browser must not
    // give the same account a second, independent pass.
    [Fact]
    public async Task Second_queue_place_for_the_same_account_returns_the_existing_pass()
    {
        var (coord, clock, eid) = New();
        clock.SetUtcNow(T0.AddSeconds(1));
        var (_, tokenA) = await Admitted(coord, eid);
        var (_, tokenB) = await Admitted(coord, eid);

        var first = await coord.RedeemAsync(tokenA, "user-a");
        var second = await coord.RedeemAsync(tokenB, "user-a");

        Assert.Equal(first.Pass, second.Pass);
    }

    [Fact]
    public async Task Redeem_refuses_a_bound_pass_presented_as_an_admission_token()
    {
        var (coord, clock, eid) = New();
        clock.SetUtcNow(T0.AddSeconds(1));
        var (_, token) = await Admitted(coord, eid);
        var pass = (await coord.RedeemAsync(token, "user-a")).Pass!;

        var r = await coord.RedeemAsync(pass, "user-a");

        Assert.Equal(RedeemOutcome.Invalid, r.Outcome);
    }

    [Fact]
    public async Task Redeem_refuses_an_expired_admission_token()
    {
        var (coord, clock, eid) = New();
        clock.SetUtcNow(T0.AddSeconds(1));
        var (_, token) = await Admitted(coord, eid);
        clock.Advance(TimeSpan.FromSeconds(901));

        var r = await coord.RedeemAsync(token, "user-a");

        Assert.Equal(RedeemOutcome.Invalid, r.Outcome);
    }
}
