using QueueService.Endpoints;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Telemetry;
using QueueService.Tokens;
using QueueService.Web;
using StackExchange.Redis;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
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
    .ValidateOnStart();

builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var opt = sp.GetRequiredService<IOptions<QueueOptions>>().Value;
    return ConnectionMultiplexer.Connect(opt.RedisConnection);
});
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<QueueStore>();
builder.Services.AddSingleton<TokenService>(sp =>
    new TokenService(sp.GetRequiredService<IOptions<QueueOptions>>().Value.HmacSecret));
builder.Services.AddSingleton<QueueCoordinator>();
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
        // NOTE: behind an ingress/proxy, enable ForwardedHeaders with trusted proxies
        // so RemoteIpAddress is the real client — do NOT trust raw X-Forwarded-For.
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
app.UseExceptionHandler();
app.UseRateLimiter();
app.UseStaticFiles();
app.MapHealthChecks("/healthz", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/readyz", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });
app.MapQueueApi();
app.MapRazorPages();
app.Run();

public partial class Program; // exposed for WebApplicationFactory in tests
