using System.Security.Cryptography;
using System.Text;
using QueueService.Queue;

namespace QueueService.Endpoints;

/// Operator controls for a running sale. Mapped only when Queue:AdminApiKey is set,
/// so a deployment that does not want them has no such routes at all.
public static class AdminEndpoints
{
    public const string KeyHeader = "X-Queue-Admin-Key";

    public static IEndpointRouteBuilder MapAdminApi(this IEndpointRouteBuilder app, string adminKey)
    {
        var expected = SHA256.HashData(Encoding.UTF8.GetBytes(adminKey));
        var admin = app.MapGroup("/api/admin/events/{eid}")
            .AddEndpointFilter(async (ctx, next) =>
            {
                // Hash both sides so the compare is constant-time whatever length the caller sends.
                var given = SHA256.HashData(Encoding.UTF8.GetBytes(
                    ctx.HttpContext.Request.Headers[KeyHeader].ToString()));
                return CryptographicOperations.FixedTimeEquals(given, expected)
                    ? await next(ctx)
                    : Results.Unauthorized();
            });

        admin.MapPost("/rate", async (string eid, RateRequest body, EventAdmin ops) =>
        {
            if (body.Rate is not > 0 || !double.IsFinite(body.Rate.Value))
                return Results.BadRequest(new { error = "rate must be a number greater than 0" });
            return Outcome(await ops.SetRateAsync(eid, body.Rate.Value));
        });
        admin.MapPost("/paused", async (string eid, PausedRequest body, EventAdmin ops) =>
            body.Paused is { } p ? Outcome(await ops.SetPausedAsync(eid, p))
                : Results.BadRequest(new { error = "paused must be true or false" }));
        admin.MapPost("/sold-out", async (string eid, SoldOutRequest body, EventAdmin ops) =>
            body.SoldOut is { } s ? Outcome(await ops.SetSoldOutAsync(eid, s))
                : Results.BadRequest(new { error = "soldOut must be true or false" }));
        return app;
    }

    private static IResult Outcome(bool found)
        => found ? Results.Ok(new { ok = true }) : Results.NotFound(new { error = "event not found" });

    public sealed record RateRequest(double? Rate);
    public sealed record PausedRequest(bool? Paused);
    public sealed record SoldOutRequest(bool? SoldOut);
}
