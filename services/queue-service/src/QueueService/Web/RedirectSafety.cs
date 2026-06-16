namespace QueueService.Web;

/// Guards the post-admission redirect target against open-redirect / token-exfil.
/// Only a same-origin absolute path (starts with a single "/") is allowed; anything
/// that could navigate off-origin — "//evil", "/\evil", "https:", "javascript:",
/// control chars — collapses to "/".
public static class RedirectSafety
{
    public static string SafeTarget(string? target)
    {
        if (string.IsNullOrEmpty(target)) return "/";
        if (target[0] != '/') return "/";                              // must be path-absolute (blocks scheme: targets)
        if (target.Length > 1 && (target[1] == '/' || target[1] == '\\')) return "/"; // blocks //evil and /\evil (protocol-relative)
        foreach (var c in target)
            if (c < 0x20 || c == 0x7f) return "/";                     // no control chars / CRLF
        return target;
    }
}
