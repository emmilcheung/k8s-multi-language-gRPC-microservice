using QueueService.Endpoints;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Telemetry;
using QueueService.Tokens;
using QueueService.Web;
using StackExchange.Redis;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Options;
using System.Threading.RateLimiting;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<QueueOptions>()
    .Bind(builder.Configuration.GetSection(QueueOptions.SectionName))
    .ValidateDataAnnotations()
    .Validate(o => !builder.Environment.IsProduction() || o.HmacSecret != QueueOptions.PlaceholderSecret,
        "Queue:HmacSecret must be changed from the shipped placeholder in Production.")
    .Validate(o => builder.Environment.IsDevelopment() || o.TrustedProxyCidrs.Count > 0,
        "Queue:TrustedProxyCidrs is required outside Development: without it every visitor "
        + "behind the ingress shares one address and one enqueue limit.")
    .Validate(o => o.TrustedProxyCidrs.All(c => System.Net.IPNetwork.TryParse(c, out _)),
        "Queue:TrustedProxyCidrs contains an entry that is not a CIDR such as 10.0.0.0/8.")
    .Validate(o => o.AdmissionTtlSeconds > QueueOptions.SeatHoldSeconds,
        "Queue:AdmissionTtlSeconds must be longer than the 10 minute seat hold (600 s): "
        + "seat hold 10 min < pass 15 min, or a buyer's pass expires while they still hold seats.")
    .Validate(o => string.IsNullOrEmpty(o.AdminApiKey) || o.AdminApiKey.Length >= 32,
        "Queue:AdminApiKey must be at least 32 characters when set (leave it empty to disable the admin API).")
    .Validate(o => string.IsNullOrEmpty(o.VenueAvailabilityUrl)
            || (o.VenueAvailabilityUrl.Contains("{eid}")
                && Uri.TryCreate(o.VenueAvailabilityUrl.Replace("{eid}", "x"), UriKind.Absolute, out var u)
                && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps)),
        "Queue:VenueAvailabilityUrl must be an http(s) URL containing {eid}.")
    .ValidateOnStart();

// Only the configured proxy networks are believed; the defaults (loopback) are
// cleared so a forged X-Forwarded-For from anywhere else is ignored.
var trustedProxies = builder.Configuration.GetSection(QueueOptions.SectionName)
    .GetSection(nameof(QueueOptions.TrustedProxyCidrs)).Get<string[]>() ?? [];
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor;
    o.KnownProxies.Clear();
    o.KnownIPNetworks.Clear();
    foreach (var cidr in trustedProxies)
        if (System.Net.IPNetwork.TryParse(cidr, out var net)) o.KnownIPNetworks.Add(net);
    o.ForwardLimit = null; // unwrap every trusted hop (CDN -> ingress); stops at the first untrusted one
});

builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var opt = sp.GetRequiredService<IOptions<QueueOptions>>().Value;
    return ConnectionMultiplexer.Connect(opt.RedisConnection);
});
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<QueueStore>();
builder.Services.AddSingleton<TokenService>(sp =>
    new TokenService(sp.GetRequiredService<IOptions<QueueOptions>>().Value.HmacSecret));
// Short timeout: the venue signal is a bonus and must never hold up a snapshot refresh.
builder.Services.AddHttpClient(EventSnapshotCache.VenueClient, c => c.Timeout = TimeSpan.FromSeconds(1));
builder.Services.AddSingleton<EventSnapshotCache>();
builder.Services.AddSingleton<EventAdmin>();
builder.Services.AddSingleton<QueueCoordinator>();
builder.Services.AddSingleton(sp => new UserIdSignature(
    sp.GetRequiredService<IOptions<QueueOptions>>().Value.UserIdSigningKey,
    sp.GetRequiredService<TimeProvider>()));
builder.Services.AddRazorPages();

// Observability (audit #12): metrics collected in-process; OTLP export when configured.
builder.Services.AddMetrics();
builder.Services.AddSingleton<QueueMetrics>();
var otel = builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("queue-service"))
    .WithMetrics(m => m.AddAspNetCoreInstrumentation().AddMeter(QueueMetrics.MeterName))
    .WithTracing(t => t.AddAspNetCoreInstrumentation());
if (!string.IsNullOrEmpty(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
    otel.UseOtlpExporter();

// Liveness = process responds; readiness = Redis reachable (audit #7).
builder.Services.AddHealthChecks()
    .AddCheck<RedisHealthCheck>("redis", tags: new[] { "ready" });
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<EventNotFoundExceptionHandler>();
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("enqueue", ctx =>
    {
        var limit = ctx.RequestServices.GetRequiredService<IOptions<QueueOptions>>().Value.EnqueuePerMinutePerIp;
        // RemoteIpAddress is the real client once UseForwardedHeaders has unwrapped
        // the trusted proxies' X-Forwarded-For.
        var key = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = limit,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        });
    });
});

var app = builder.Build();
// With no trusted networks the middleware would believe every sender, so it is
// only added once some are configured (Development may leave the list empty).
if (trustedProxies.Length > 0) app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseRateLimiter();
app.UseStaticFiles();
app.MapHealthChecks("/healthz", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/readyz", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });
app.MapQueueApi();
if (app.Services.GetRequiredService<IOptions<QueueOptions>>().Value.AdminApiKey is { Length: > 0 } adminKey)
    app.MapAdminApi(adminKey);
app.MapRazorPages();
app.Run();

public partial class Program; // exposed for WebApplicationFactory in tests
