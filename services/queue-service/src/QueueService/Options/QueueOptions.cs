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

    /// Seats are held for this long while a buyer checks out; the pass must outlive it.
    public const int SeatHoldSeconds = 600;

    /// Lifetime of both the admission token and the purchase pass: long enough
    /// to pick seats and check out, and longer than the seat hold.
    [Range(1, 86400)]
    public int AdmissionTtlSeconds { get; set; } = 900;

    [Range(1, 3600)]
    public int SlidingGraceSeconds { get; set; } = 60;

    /// Per pod: each replica keeps its own counter, so the effective global limit is
    /// this value times the replica count. Size it as target limit / minimum replicas.
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

    /// Networks (CIDR) of the proxies allowed to set X-Forwarded-For, e.g. the ingress
    /// controller's pod network. Only a hop inside these networks is believed; the
    /// client address is then the first hop outside them. Required outside Development,
    /// where an empty list means the connection's own address is used.
    public List<string> TrustedProxyCidrs { get; set; } = new();

    /// Where to ask how many seats are left, with {eid} standing for the event id,
    /// e.g. http://venue-service:8080/internal/tickets/{eid}/availability. Optional:
    /// empty means no automatic paused / sold-out signal, only the operator's flags.
    public string? VenueAvailabilityUrl { get; set; }

    /// Enables the operator endpoints under /api/admin (header X-Queue-Admin-Key).
    /// Empty means they are not mapped at all. At least 32 characters when set.
    public string? AdminApiKey { get; set; }

    /// Port the operator endpoints are served on, in addition to the public one: they are
    /// answered ONLY on this port (404 elsewhere), and it must never be routed through the
    /// public ingress. Required when AdminApiKey is set, and must differ from the public port.
    [Range(1, 65535)]
    public int? AdminPort { get; set; }
}
