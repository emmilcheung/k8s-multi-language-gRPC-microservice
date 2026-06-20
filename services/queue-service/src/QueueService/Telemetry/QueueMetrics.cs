using System.Diagnostics.Metrics;

namespace QueueService.Telemetry;

/// Application metrics for the waiting room. Always collected in-process; exported
/// via OpenTelemetry/OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is configured.
public sealed class QueueMetrics
{
    public const string MeterName = "QueueService";

    private readonly Counter<long> _enqueued;
    private readonly Counter<long> _admitted;
    private readonly Counter<long> _rejected;
    private readonly Histogram<double> _wait;

    public QueueMetrics(IMeterFactory factory)
    {
        var m = factory.Create(MeterName);
        _enqueued = m.CreateCounter<long>("queue.enqueued", unit: "{visitor}");
        _admitted = m.CreateCounter<long>("queue.admitted", unit: "{visitor}");
        _rejected = m.CreateCounter<long>("queue.claim_rejected", unit: "{visitor}");
        _wait = m.CreateHistogram<double>("queue.estimated_wait", unit: "s");
    }

    public void Enqueued(string phase) =>
        _enqueued.Add(1, new KeyValuePair<string, object?>("phase", phase));
    public void Admitted() => _admitted.Add(1);
    public void ClaimRejected() => _rejected.Add(1);
    public void RecordWait(double seconds) => _wait.Record(seconds);
}
