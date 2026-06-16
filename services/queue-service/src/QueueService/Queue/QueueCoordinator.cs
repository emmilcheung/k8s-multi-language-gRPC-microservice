using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using QueueService.Admission;
using QueueService.Options;
using QueueService.Telemetry;
using QueueService.Tokens;

namespace QueueService.Queue;

/// Orchestrates store + tokens + clock. Used by both the API and the Razor page.
public sealed class QueueCoordinator(
    QueueStore store, TokenService tokens, TimeProvider clock, IOptions<QueueOptions> options,
    QueueMetrics? metrics = null)
{
    private readonly QueueOptions _opt = options.Value;

    public async Task<EventConfig> RequireConfigAsync(string eid)
        => await store.GetConfigAsync(eid)
           ?? throw new EventNotFoundException(eid);

    public Task<EventConfig?> GetConfigOrNullAsync(string eid) => store.GetConfigAsync(eid);

    public async Task<EnqueueResult> EnqueueAsync(string eid, PreQueueTicket? existing)
    {
        var cfg = await RequireConfigAsync(eid);
        var now = clock.GetUtcNow();
        var mid = existing?.Mid ?? Guid.NewGuid().ToString("N");
        var r = existing?.R ?? RandomNumberGenerator.GetInt32(int.MaxValue) / (double)int.MaxValue;

        if (now < cfg.T0)
        {
            var added = await store.EnqueuePreQueueAsync(eid, mid, r, _opt.MaxPreQueueSize, _opt.KeyTtlSeconds);
            if (!added) throw new QueueFullException(eid);
            await store.RefreshConfigTtlAsync(eid, _opt.KeyTtlSeconds);
            var ticket = new PreQueueTicket(eid, mid, r, null, "pre", now.ToUnixTimeSeconds());
            metrics?.Enqueued("pre");
            return new EnqueueResult(ticket, "pre", null, cfg);
        }

        var pqSize = await store.FreezePreQueueSizeAsync(eid);
        var pos = await store.EnqueueLateAsync(eid, mid, pqSize, _opt.KeyTtlSeconds);
        await store.RefreshConfigTtlAsync(eid, _opt.KeyTtlSeconds);
        var late = new PreQueueTicket(eid, mid, r, pos, "late", now.ToUnixTimeSeconds());
        metrics?.Enqueued("late");
        return new EnqueueResult(late, "late", pos, cfg);
    }

    public async Task<StatusResult> GetStatusAsync(string eid, PreQueueTicket ticket)
    {
        var cfg = await RequireConfigAsync(eid);
        var now = clock.GetUtcNow();
        var (position, updated) = await ResolvePositionAsync(eid, ticket, cfg, now);
        var serving = AdmissionCalculator.Serving(now, cfg.T0, cfg.Rate);
        var wait = AdmissionCalculator.EstimatedWaitSeconds(position, serving, cfg.Rate);
        metrics?.RecordWait(wait);
        return new StatusResult(
            updated, position, serving,
            AdmissionCalculator.IsAdmitted(position, serving),
            wait);
    }

    public async Task<ClaimResult> ClaimAsync(string eid, PreQueueTicket ticket)
    {
        var status = await GetStatusAsync(eid, ticket);
        if (!status.Admitted)
        {
            metrics?.ClaimRejected();
            return new ClaimResult(false, null, status.Ticket);
        }
        metrics?.Admitted();

        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var token = new AdmissionToken(
            eid, status.Ticket.Mid, now, now + _opt.AdmissionTtlSeconds,
            Guid.NewGuid().ToString("N"));
        return new ClaimResult(true, tokens.Sign(token), status.Ticket);
    }

    /// Verifies an admission token (HMAC + expiry) and consumes its nonce once.
    public async Task<RedeemOutcome> RedeemAsync(string token)
    {
        if (!tokens.TryVerify<AdmissionToken>(token, out var t) || t is null) return RedeemOutcome.Invalid;
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        if (t.Exp <= now) return RedeemOutcome.Invalid; // expired
        var first = await store.TryConsumeNonceAsync(t.Nonce, (int)(t.Exp - now));
        return first ? RedeemOutcome.Ok : RedeemOutcome.AlreadyUsed;
    }

    public async Task<long> ServingAsync(string eid)
    {
        var cfg = await RequireConfigAsync(eid);
        return AdmissionCalculator.Serving(clock.GetUtcNow(), cfg.T0, cfg.Rate);
    }

    // Returns the member's position and a (possibly updated, position-frozen) ticket.
    private async Task<(long position, PreQueueTicket ticket)> ResolvePositionAsync(
        string eid, PreQueueTicket ticket, EventConfig cfg, DateTimeOffset now)
    {
        if (ticket.Pos is long fixedPos) return (fixedPos, ticket);

        // Pre-queue member whose position is not yet frozen.
        if (now < cfg.T0)
        {
            var provisional = await store.RankInPreQueueAsync(eid, ticket.Mid) ?? 0;
            return (provisional, ticket); // not frozen; serving=0 before T0 so never admitted
        }

        await store.FreezePreQueueSizeAsync(eid);
        var rank = await store.RankInPreQueueAsync(eid, ticket.Mid) ?? 0;
        var frozen = ticket with { Pos = rank, Phase = "pre" };
        return (rank, frozen);
    }
}
