using Microsoft.AspNetCore.Diagnostics;
using QueueService.Queue;

namespace QueueService.Web;

/// Maps a missing-event reference to 404 instead of an unhandled 500.
/// All other exceptions fall through to ProblemDetails (500, no stack leak).
public sealed class EventNotFoundExceptionHandler : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception exception, CancellationToken ct)
    {
        switch (exception)
        {
            case EventNotFoundException:
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                await ctx.Response.WriteAsJsonAsync(new { error = "event not found" }, ct);
                return true;
            case QueueFullException:
                ctx.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                await ctx.Response.WriteAsJsonAsync(new { error = "queue full, retry later" }, ct);
                return true;
            default:
                return false;
        }
    }
}
