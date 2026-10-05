using QueueService.Admission;

namespace QueueService.Queue;

/// ServingBase / TBase rebase the admission count after a rate change or a resume
/// (TBase defaults to T0, so older configs without them behave as before).
/// SoldOut and Paused are the operator's flags.
public sealed record EventConfig(
    string Eid, DateTimeOffset T0, double Rate, bool Armed, long? PreQueueSize,
    long ServingBase = 0, DateTimeOffset? TBase = null, bool SoldOut = false, bool Paused = false)
{
    /// While the operator has paused, nobody new is admitted: serving stays at the base.
    public long ServingAt(DateTimeOffset now)
        => Paused ? ServingBase : AdmissionCalculator.Serving(now, T0, Rate, ServingBase, TBase ?? T0);
}
