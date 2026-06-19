using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.Extensions.Options;
using QueueService.Endpoints;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Tokens;
using QueueService.Web;

namespace QueueService.Pages;

public class WaitModel(QueueCoordinator coord, TokenService tokens, IOptions<QueueOptions> options) : PageModel
{
    [BindProperty(SupportsGet = true, Name = "e")] public string Eid { get; set; } = "";
    [BindProperty(SupportsGet = true, Name = "target")] public string Target { get; set; } = "/";
    public long T0Unix { get; private set; }
    public double Rate { get; private set; }

    public async Task<IActionResult> OnGetAsync()
    {
        Target = RedirectSafety.SafeTarget(Target, options.Value.AllowedTargetOrigins);

        var cfg = await coord.GetConfigOrNullAsync(Eid);
        if (cfg is null) return NotFound();

        var existing = Request.Cookies.TryGetValue(QueueEndpoints.TicketCookie, out var raw)
            && tokens.TryVerify<PreQueueTicket>(raw!, out var t) && t!.Eid == Eid ? t : null;

        var enq = await coord.EnqueueAsync(Eid, existing);
        Response.Cookies.Append(QueueEndpoints.TicketCookie, tokens.Sign(enq.Ticket),
            new CookieOptions { HttpOnly = true, IsEssential = true, SameSite = SameSiteMode.Lax });

        T0Unix = cfg.T0.ToUnixTimeMilliseconds();
        Rate = cfg.Rate;
        return Page();
    }
}
