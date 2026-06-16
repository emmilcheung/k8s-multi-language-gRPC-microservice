using QueueService.Endpoints;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Tokens;
using QueueService.Web;
using StackExchange.Redis;
using Microsoft.Extensions.Options;

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

var app = builder.Build();
app.UseExceptionHandler();
app.UseStaticFiles();
app.MapHealthChecks("/healthz");
app.MapQueueApi();
app.MapRazorPages();
app.Run();

public partial class Program; // exposed for WebApplicationFactory in tests
