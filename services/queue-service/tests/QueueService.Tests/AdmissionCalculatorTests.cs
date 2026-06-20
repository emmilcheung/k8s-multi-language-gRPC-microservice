using QueueService.Admission;
using Xunit;

public class AdmissionCalculatorTests
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);

    [Fact] public void Serving_is_zero_before_T0()
        => Assert.Equal(0, AdmissionCalculator.Serving(T0.AddSeconds(-5), T0, rate: 100));

    [Fact] public void Serving_grows_with_elapsed_time_times_rate()
        => Assert.Equal(1000, AdmissionCalculator.Serving(T0.AddSeconds(10), T0, rate: 100));

    [Theory]
    [InlineData(999, 1000, true)]
    [InlineData(1000, 1000, false)]
    public void Position_admitted_when_strictly_below_serving(long pos, long serving, bool expected)
        => Assert.Equal(expected, AdmissionCalculator.IsAdmitted(pos, serving));

    [Fact] public void Wait_is_remaining_positions_over_rate()
        => Assert.Equal(5.0, AdmissionCalculator.EstimatedWaitSeconds(position: 1500, serving: 1000, rate: 100), 3);

    [Fact] public void Wait_is_zero_when_already_admitted()
        => Assert.Equal(0.0, AdmissionCalculator.EstimatedWaitSeconds(position: 10, serving: 1000, rate: 100));
}
