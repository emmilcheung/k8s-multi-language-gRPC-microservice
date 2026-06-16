var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHealthChecks();

var app = builder.Build();
app.MapHealthChecks("/healthz");
app.MapGet("/", () => Results.Ok("queue-service"));
app.Run();

public partial class Program; // exposed for WebApplicationFactory in tests
