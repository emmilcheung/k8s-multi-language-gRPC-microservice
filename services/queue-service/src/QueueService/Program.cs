using QueueService.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<QueueOptions>()
    .Bind(builder.Configuration.GetSection(QueueOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddHealthChecks();

var app = builder.Build();
app.MapHealthChecks("/healthz");
app.MapGet("/", () => Results.Ok("queue-service"));
app.Run();

public partial class Program; // exposed for WebApplicationFactory in tests
