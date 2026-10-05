using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using QueueService.Admission;
using QueueService.Options;
using QueueService.Telemetry;
using QueueService.Tokens;

namespace QueueService.Queue;

/// Orchestrates store + tokens + clock. Used by both the API and the Razor page.
public sealed class QueueCoordinator(
    QueueStore store, EventSnapshotCache snapshots, TokenService tokens, TimeProvider clock,
    IOptions<QueueOptions> options, QueueMetrics? metrics = null)
{
    private readonly QueueOptions _opt = options.Value;

    // Config comes from the per-pod snapshot (at most a second old), not a Redis read per call.
    private async Task<EventSnapshot> RequireSnapshotAsync(string eid)
        => await snapshots.GetAsync(eid) ?? throw new EventNotFoundException(eid);

    public async Task<EventConfig?> GetConfigOrNullAsync(string eid)
        => (await snapshots.GetAsync(eid))?.Config;

    public async Task<EnqueueResult> EnqueueAsync(string eid, PreQueueTicket? existing)
    {
        var cfg = (await RequireSnapshotAsync(eid)).Config;
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
        var snap = await RequireSnapshotAsync(eid);
        var cfg = snap.Config;
        var now = clock.GetUtcNow();
        var (position, updated) = await ResolvePositionAsync(eid, ticket, cfg, now);
        var serving = snap.Serving(now);
        var wait = AdmissionCalculator.EstimatedWaitSeconds(position, serving, cfg.Rate);
        metrics?.RecordWait(wait);
        return new StatusResult(
            updated, position, serving,
            AdmissionCalculator.IsAdmitted(position, serving),
            wait, snap.SoldOut, snap.Paused);
    }

    public async Task<ClaimResult> ClaimAsync(string eid, PreQueueTicket ticket)
    {
        // A token is issued on this decision, so it needs a snapshot from the last refresh
        // interval, not the stale one status polls can use.
        var snap = await snapshots.GetFreshAsync(eid) ?? throw new EventNotFoundException(eid);
        if (snap.SoldOut || snap.Paused)
        {
            metrics?.ClaimRejected();
            return new ClaimResult(false, null, ticket, snap.SoldOut, snap.Paused);
        }
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

    /// Exchanges an admission token for a purchase pass bound to <paramref name="sub"/>.
    /// The queue place goes to the first account that redeems it; that account
    /// gets one pass per event, and the same pass again on a repeat (refresh,
    /// second tab), so the single-use nonce only stops a token minting twice.
    public async Task<RedeemResult> RedeemAsync(string token, string sub)
    {
        if (!tokens.TryVerify<AdmissionToken>(token, out var t) || t is null || t.Sub is not null)
            return new RedeemResult(RedeemOutcome.Invalid);
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        if (t.Exp <= now) return new RedeemResult(RedeemOutcome.Invalid); // expired

        if (await store.BindOwnerAsync(t.Eid, t.Mid, sub, _opt.KeyTtlSeconds) != sub)
            return new RedeemResult(RedeemOutcome.OtherAccount);

        if (await store.GetPassAsync(t.Eid, sub) is { } existing)
            return new RedeemResult(RedeemOutcome.Ok, existing);

        if (!await store.TryConsumeNonceAsync(t.Nonce, (int)(t.Exp - now)))
            return new RedeemResult(RedeemOutcome.AlreadyUsed);

        var pass = tokens.Sign(new AdmissionToken(
            t.Eid, t.Mid, now, now + _opt.AdmissionTtlSeconds, Guid.NewGuid().ToString("N"), sub));
        return new RedeemResult(RedeemOutcome.Ok,
            await store.SetPassOnceAsync(t.Eid, sub, pass, _opt.AdmissionTtlSeconds));
    }

    public async Task<ServingResult> ServingAsync(string eid)
    {
        var snap = await RequireSnapshotAsync(eid);
        return new ServingResult(snap.Serving(clock.GetUtcNow()), snap.Config.Rate, snap.SoldOut, snap.Paused);
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
