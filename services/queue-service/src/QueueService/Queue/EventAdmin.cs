using StackExchange.Redis;

namespace QueueService.Queue;

/// Operator controls. A rate change and a resume rebase the admission count to
/// "now", so serving continues from where it was: never a burst, never a drop.
/// Each reads the live config (not the pod snapshot) and writes its fields in one HSET.
/// Two operators changing the same event at the same instant could interleave;
/// that is accepted for a handful of manual actions.
public sealed class EventAdmin(QueueStore store, TimeProvider clock)
{
    /// Each method returns false when the event does not exist.
    public async Task<bool> SetRateAsync(string eid, double rate)
    {
        if (await store.GetConfigAsync(eid) is not { } cfg) return false;
        var now = clock.GetUtcNow();
        return await store.UpdateConfigFieldsAsync(eid,
            new("servingBase", cfg.ServingAt(now)),
            new("tBase", RebaseTime(cfg, now)),
            new("rate", rate));
    }

    public async Task<bool> SetPausedAsync(string eid, bool paused)
    {
        if (await store.GetConfigAsync(eid) is not { } cfg) return false;
        if (cfg.Paused == paused) return true; // resuming a running sale must not reset its clock
        var now = clock.GetUtcNow();
        return paused
            ? await store.UpdateConfigFieldsAsync(eid,
                new("servingBase", cfg.ServingAt(now)), new("paused", 1))
            : await store.UpdateConfigFieldsAsync(eid,
                new("tBase", RebaseTime(cfg, now)), new("paused", 0));
    }

    public async Task<bool> SetSoldOutAsync(string eid, bool soldOut)
        => await store.GetConfigAsync(eid) is not null
           && await store.UpdateConfigFieldsAsync(eid, new HashEntry("soldout", soldOut ? 1 : 0));

    // Never earlier than T0: time before the sale opens must not count as admitted.
    private static long RebaseTime(EventConfig cfg, DateTimeOffset now)
        => (now > cfg.T0 ? now : cfg.T0).ToUnixTimeMilliseconds();
}
