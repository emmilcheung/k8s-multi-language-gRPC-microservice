namespace QueueService.Admission;

/// Rate-based admission math. serving(t) = floor(rate * seconds since T0), 0 before T0.
public static class AdmissionCalculator
{
    public static long Serving(DateTimeOffset now, DateTimeOffset t0, double rate)
        => Serving(now, t0, rate, servingBase: 0, tBase: t0);

    /// Rebased form: servingBase + floor(rate * seconds since tBase), still 0 before T0.
    /// A rate change or a resume moves (servingBase, tBase) to "now" so the count
    /// continues from where it was instead of jumping.
    public static long Serving(DateTimeOffset now, DateTimeOffset t0, double rate,
        long servingBase, DateTimeOffset tBase)
    {
        if (rate <= 0) throw new ArgumentOutOfRangeException(nameof(rate));
        if (now <= t0) return 0;
        var elapsed = Math.Max(0, (now - tBase).TotalSeconds);
        return servingBase + (long)Math.Floor(rate * elapsed);
    }

    // 0-based position is admitted once strictly less than the served count.
    public static bool IsAdmitted(long position, long serving) => position < serving;

    public static double EstimatedWaitSeconds(long position, long serving, double rate)
    {
        if (rate <= 0) throw new ArgumentOutOfRangeException(nameof(rate));
        var ahead = position - serving;
        return ahead <= 0 ? 0 : ahead / rate;
    }
}
