using QueueService.Endpoints;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Tokens;
using QueueService.Web;
using StackExchange.Redis;
using Microsoft.Extensions.Options;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<QueueOptions>()
    .Bind(builder.Configuration.GetSection(QueueOptions.SectionName))
    .ValidateDataAnnotations()
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
builder.Services.AddHealthChecks();
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
app.MapHealthChecks("/healthz");
app.MapQueueApi();
app.MapRazorPages();
app.Run();

public partial class Program; // exposed for WebApplicationFactory in tests
