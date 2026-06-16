using QueueService.Queue;
using QueueService.Tokens;

namespace QueueService.Endpoints;

public static class QueueEndpoints
{
    public const string TicketCookie = "qq_ticket";

    public static IEndpointRouteBuilder MapQueueApi(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/serving", async (string e, QueueCoordinator coord, HttpResponse res) =>
        {
            var serving = await coord.ServingAsync(e);
            res.Headers.CacheControl = "public, max-age=1";
            return Results.Ok(new { serving });
        });

        app.MapPost("/api/enqueue", async (string e, HttpRequest req, HttpResponse res,
            QueueCoordinator coord, TokenService tokens) =>
        {
            var existing = ReadTicket(req, tokens, e);
            var r = await coord.EnqueueAsync(e, existing);
            WriteTicket(res, tokens, r.Ticket);
            return Results.Ok(new { mid = r.Ticket.Mid, phase = r.Phase, position = r.Position });
        }).RequireRateLimiting("enqueue");

        app.MapGet("/api/status", async (string e, HttpRequest req, HttpResponse res,
            QueueCoordinator coord, TokenService tokens) =>
        {
            var ticket = ReadTicket(req, tokens, e);
            if (ticket is null) return Results.Unauthorized();
            var st = await coord.GetStatusAsync(e, ticket);
            WriteTicket(res, tokens, st.Ticket); // refresh frozen position
            return Results.Ok(new { position = st.Position, serving = st.Serving,
                admitted = st.Admitted, waitSeconds = st.WaitSeconds });
        });

        app.MapPost("/api/claim", async (string e, HttpRequest req, HttpResponse res,
            QueueCoordinator coord, TokenService tokens) =>
        {
            var ticket = ReadTicket(req, tokens, e);
            if (ticket is null) return Results.Unauthorized();
            var claim = await coord.ClaimAsync(e, ticket);
            WriteTicket(res, tokens, claim.Ticket);
            return claim.Admitted
                ? Results.Ok(new { token = claim.Token })
                : Results.StatusCode(425); // Too Early — admitted boundary not reached
        });

        return app;
    }

    private static PreQueueTicket? ReadTicket(HttpRequest req, TokenService tokens, string eid)
    {
        if (!req.Cookies.TryGetValue(TicketCookie, out var raw)) return null;
        return tokens.TryVerify<PreQueueTicket>(raw!, out var t) && t!.Eid == eid ? t : null;
    }

    private static void WriteTicket(HttpResponse res, TokenService tokens, PreQueueTicket ticket)
        => res.Cookies.Append(TicketCookie, tokens.Sign(ticket), new CookieOptions
        {
            HttpOnly = true, IsEssential = true,
            SameSite = SameSiteMode.Lax, Secure = false // Secure=true behind TLS in real deploys
        });
}
