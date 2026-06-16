namespace QueueService.Admission;

/// Rate-based admission math. serving(t) = floor(rate * seconds since T0), 0 before T0.
public static class AdmissionCalculator
{
    public static long Serving(DateTimeOffset now, DateTimeOffset t0, double rate)
    {
        if (rate <= 0) throw new ArgumentOutOfRangeException(nameof(rate));
        var elapsed = (now - t0).TotalSeconds;
        return elapsed <= 0 ? 0 : (long)Math.Floor(rate * elapsed);
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
