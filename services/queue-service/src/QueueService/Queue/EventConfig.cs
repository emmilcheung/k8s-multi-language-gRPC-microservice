using QueueService.Admission;

namespace QueueService.Queue;

/// ServingBase / TBase rebase the admission count after a rate change or a resume
/// (TBase defaults to T0, so older configs without them behave as before).
/// SoldOut and Paused are the operator's flags. VenuePaused is set by whichever pod
/// first sees the venue report paused or sold out; like Paused it freezes serving.
public sealed record EventConfig(
    string Eid, DateTimeOffset T0, double Rate, bool Armed, long? PreQueueSize,
    long ServingBase = 0, DateTimeOffset? TBase = null, bool SoldOut = false, bool Paused = false,
    bool VenuePaused = false)
{
    /// While the operator or the venue has paused, nobody new is admitted: serving
    /// stays at the base. It stays frozen until both have ended.
    public long ServingAt(DateTimeOffset now)
        => Paused || VenuePaused ? ServingBase : AdmissionCalculator.Serving(now, T0, Rate, ServingBase, TBase ?? T0);
}
