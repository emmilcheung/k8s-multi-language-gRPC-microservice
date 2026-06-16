using System.ComponentModel.DataAnnotations;

namespace QueueService.Options;

public sealed class QueueOptions
{
    public const string SectionName = "Queue";

    /// The secret shipped in compose/.env/helm samples. Rejected at startup in
    /// Production so a deployment cannot accidentally run with a known signing key.
    public const string PlaceholderSecret = "dev-secret-change-me-32-chars-minimum";

    [Required, MinLength(32)]
    public string HmacSecret { get; set; } = string.Empty;

    [Required]
    public string RedisConnection { get; set; } = string.Empty;

    [Range(1, 86400)]
    public int AdmissionTtlSeconds { get; set; } = 600;

    [Range(1, 3600)]
    public int SlidingGraceSeconds { get; set; } = 60;

    [Range(1, 100000)]
    public int EnqueuePerMinutePerIp { get; set; } = 60;

    [Range(1, int.MaxValue)]
    public int MaxPreQueueSize { get; set; } = 1_000_000;

    [Range(1, 2592000)]
    public int KeyTtlSeconds { get; set; } = 86400;
}
