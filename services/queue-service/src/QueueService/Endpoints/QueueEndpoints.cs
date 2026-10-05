using QueueService.Queue;
using QueueService.Tokens;
using QueueService.Web;

namespace QueueService.Endpoints;

public static class QueueEndpoints
{
    public const string TicketCookie = "qq_ticket";

    public static IEndpointRouteBuilder MapQueueApi(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/serving", async (string e, QueueCoordinator coord, HttpResponse res) =>
        {
            var r = await coord.ServingAsync(e);
            res.Headers.CacheControl = "public, max-age=2";
            return Results.Ok(new { serving = r.Serving, rate = r.Rate, soldOut = r.SoldOut, paused = r.Paused });
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
                admitted = st.Admitted, waitSeconds = st.WaitSeconds,
                soldOut = st.SoldOut, paused = st.Paused });
        });

        app.MapPost("/api/claim", async (string e, HttpRequest req, HttpResponse res,
            QueueCoordinator coord, TokenService tokens) =>
        {
            var ticket = ReadTicket(req, tokens, e);
            if (ticket is null) return Results.Unauthorized();
            var claim = await coord.ClaimAsync(e, ticket);
            if (claim.SoldOut || claim.Paused)
                return Results.Conflict(new
                {
                    error = claim.SoldOut ? "sold out" : "admission is paused",
                    soldOut = claim.SoldOut, paused = claim.Paused,
                });
            WriteTicket(res, tokens, claim.Ticket);
            return claim.Admitted
                ? Results.Ok(new { token = claim.Token })
                : Results.StatusCode(425); // Too Early — admitted boundary not reached
        });

        // Reached through Kong's /api/queue/redeem route, which validates the
        // login JWT and adds a signed X-User-Id. The queue host is public too,
        // so the signature, not the header, is what identifies the account.
        app.MapPost("/api/redeem", async (RedeemRequest body, HttpRequest req,
            QueueCoordinator coord, UserIdSignature userIds) =>
        {
            var sub = req.Headers["X-User-Id"].ToString();
            if (!userIds.IsValid(sub, req.Headers["X-User-Id-Sig"].ToString()))
                return Results.Unauthorized();
            var r = await coord.RedeemAsync(body.Token ?? "", sub);
            return r.Outcome switch
            {
                RedeemOutcome.Ok => Results.Ok(new { pass = r.Pass }),
                RedeemOutcome.AlreadyUsed => Results.Conflict(new { error = "token already used" }),
                RedeemOutcome.OtherAccount => Results.Json(
                    new { error = "this queue place belongs to another account" }, statusCode: 403),
                _ => Results.BadRequest(new { error = "invalid admission token" }),
            };
        });

        return app;
    }

    public sealed record RedeemRequest(string? Token);

    private static PreQueueTicket? ReadTicket(HttpRequest req, TokenService tokens, string eid)
    {
        if (!req.Cookies.TryGetValue(TicketCookie, out var raw)) return null;
        return tokens.TryVerify<PreQueueTicket>(raw!, out var t) && t!.Eid == eid ? t : null;
    }

    private static void WriteTicket(HttpResponse res, TokenService tokens, PreQueueTicket ticket)
        => res.Cookies.Append(TicketCookie, tokens.Sign(ticket), new CookieOptions
        {
            HttpOnly = true, IsEssential = true, SameSite = SameSiteMode.Lax,
            // Local development serves the waiting page over plain http.
            Secure = !res.HttpContext.RequestServices.GetRequiredService<IWebHostEnvironment>().IsDevelopment()
        });
}
