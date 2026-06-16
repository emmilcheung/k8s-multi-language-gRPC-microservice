using System.ComponentModel.DataAnnotations;

namespace QueueService.Options;

public sealed class QueueOptions
{
    public const string SectionName = "Queue";

    [Required, MinLength(32)]
    public string HmacSecret { get; set; } = string.Empty;

    [Required]
    public string RedisConnection { get; set; } = string.Empty;

    [Range(1, 86400)]
    public int AdmissionTtlSeconds { get; set; } = 600;

    [Range(1, 3600)]
    public int SlidingGraceSeconds { get; set; } = 60;
}
