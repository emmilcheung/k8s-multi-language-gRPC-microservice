using System.Security.Cryptography;
using System.Text;
using QueueService.Queue;

namespace QueueService.Endpoints;

/// Operator controls for a running sale. Mapped only when Queue:AdminApiKey is set,
/// so a deployment that does not want them has no such routes at all. They answer
/// only on the separate admin port (404 on the public one), which is never routed
/// through the ingress.
public static class AdminEndpoints
{
    public const string KeyHeader = "X-Queue-Admin-Key";
    /// Largest admission rate an operator may set (per second); keeps rate * elapsed far from overflow.
    public const double MaxRate = 100_000;

    public static IEndpointRouteBuilder MapAdminApi(this IEndpointRouteBuilder app, string adminKey, int adminPort)
    {
        var expected = SHA256.HashData(Encoding.UTF8.GetBytes(adminKey));
        var admin = app.MapGroup("/api/admin/events/{eid}")
            .AddEndpointFilter(async (ctx, next) =>
            {
                // The local port is the socket the request arrived on, so unlike the Host
                // header a caller on the public port cannot claim to be on the admin one.
                if (ctx.HttpContext.Connection.LocalPort != adminPort) return Results.NotFound();
                return await next(ctx);
            })
            .AddEndpointFilter(async (ctx, next) =>
            {
                // Hash both sides so the compare is constant-time whatever length the caller sends.
                var given = SHA256.HashData(Encoding.UTF8.GetBytes(
                    ctx.HttpContext.Request.Headers[KeyHeader].ToString()));
                return CryptographicOperations.FixedTimeEquals(given, expected)
                    ? await next(ctx)
                    : Results.Unauthorized();
            });

        admin.MapPost("/rate", async (string eid, RateRequest body, EventAdmin ops, ILoggerFactory logs) =>
        {
            if (body.Rate is not > 0 || body.Rate > MaxRate || !double.IsFinite(body.Rate.Value))
                return Results.BadRequest(new { error = $"rate must be a number greater than 0 and at most {MaxRate:0}" });
            return Outcome(logs, eid, "rate", body.Rate.Value, await ops.SetRateAsync(eid, body.Rate.Value));
        });
        admin.MapPost("/paused", async (string eid, PausedRequest body, EventAdmin ops, ILoggerFactory logs) =>
            body.Paused is { } p ? Outcome(logs, eid, "paused", p, await ops.SetPausedAsync(eid, p))
                : Results.BadRequest(new { error = "paused must be true or false" }));
        admin.MapPost("/sold-out", async (string eid, SoldOutRequest body, EventAdmin ops, ILoggerFactory logs) =>
            body.SoldOut is { } s ? Outcome(logs, eid, "sold-out", s, await ops.SetSoldOutAsync(eid, s))
                : Results.BadRequest(new { error = "soldOut must be true or false" }));
        return app;
    }

    // Audit trail of operator actions: what changed on which event, never the key.
    private static IResult Outcome(ILoggerFactory logs, string eid, string action, object value, bool found)
    {
        logs.CreateLogger("QueueService.Admin").LogInformation(
            "Admin action {Action} on event {Eid} set to {Value} (event found: {Found})", action, eid, value, found);
        return found ? Results.Ok(new { ok = true }) : Results.NotFound(new { error = "event not found" });
    }

    public sealed record RateRequest(double? Rate);
    public sealed record PausedRequest(bool? Paused);
    public sealed record SoldOutRequest(bool? SoldOut);
}
