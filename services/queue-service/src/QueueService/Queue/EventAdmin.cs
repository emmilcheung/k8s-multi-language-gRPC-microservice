namespace QueueService.Queue;

/// Operator controls. A rate change and a resume rebase the admission count to
/// "now", so serving continues from where it was: never a burst, never a drop.
/// Each one reads the live config, computes the rebase and writes it in a single
/// Redis script, so two operators changing the same event cannot overwrite each other.
public sealed class EventAdmin(QueueStore store, TimeProvider clock)
{
    /// Each method returns false when the event does not exist.
    public Task<bool> SetRateAsync(string eid, double rate)
        => store.AdminUpdateAsync(eid, "rate", rate, clock.GetUtcNow());

    public Task<bool> SetPausedAsync(string eid, bool paused)
        => store.AdminUpdateAsync(eid, "paused", paused ? 1 : 0, clock.GetUtcNow());

    public Task<bool> SetSoldOutAsync(string eid, bool soldOut)
        => store.AdminUpdateAsync(eid, "soldout", soldOut ? 1 : 0, clock.GetUtcNow());
}
