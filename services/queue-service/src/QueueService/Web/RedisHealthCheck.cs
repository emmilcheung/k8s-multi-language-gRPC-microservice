using Microsoft.Extensions.Diagnostics.HealthChecks;
using StackExchange.Redis;

namespace QueueService.Web;

/// Readiness check: the pod is only "ready" if its Redis is reachable, so a pod
/// with a dead Redis connection is pulled from the Service instead of serving 500s.
public sealed class RedisHealthCheck(IConnectionMultiplexer mux) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            await mux.GetDatabase().PingAsync();
            return HealthCheckResult.Healthy();
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("redis unreachable", ex);
        }
    }
}
