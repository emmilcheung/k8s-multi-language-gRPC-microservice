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

    /// Signs X-User-Id on requests Kong forwards (KONG_SIGNING_KEY there,
    /// X_USER_ID_SIGNING_KEY in .env). Redeem needs it to know the account.
    [Required, MinLength(32)]
    public string UserIdSigningKey { get; set; } = string.Empty;

    /// Lifetime of both the admission token and the purchase pass: long enough
    /// to pick seats and check out.
    [Range(1, 86400)]
    public int AdmissionTtlSeconds { get; set; } = 900;

    [Range(1, 3600)]
    public int SlidingGraceSeconds { get; set; } = 60;

    [Range(1, 100000)]
    public int EnqueuePerMinutePerIp { get; set; } = 60;

    [Range(1, int.MaxValue)]
    public int MaxPreQueueSize { get; set; } = 1_000_000;

    [Range(1, 2592000)]
    public int KeyTtlSeconds { get; set; } = 86400;

    /// Origins (scheme + host + port) allowed as cross-domain admission redirect targets.
    /// Example: [ "https://www.example.com", "http://localhost:4000" ].
    /// Empty list means only same-origin relative paths are accepted.
    public List<string> AllowedTargetOrigins { get; set; } = new();
}
