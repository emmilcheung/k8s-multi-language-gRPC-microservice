using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.Extensions.Options;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Web;

namespace QueueService.Pages;

public class WaitModel(QueueCoordinator coord, IOptions<QueueOptions> options) : PageModel
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

        // Rendering only: wait.js joins through the rate-limited POST /api/enqueue.
        T0Unix = cfg.T0.ToUnixTimeMilliseconds();
        Rate = cfg.Rate;
        return Page();
    }
}
