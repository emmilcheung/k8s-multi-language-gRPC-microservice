namespace QueueService.Web;

/// Guards the post-admission redirect target against open-redirect / token-exfil.
///
/// Two forms are accepted:
///   1. Absolute path — starts with exactly one "/". Same-origin navigation.
///   2. Absolute http/https URL — cross-domain deployment where the waiting room
///      runs on a separate subdomain. In production, callers should also validate
///      the URL's origin against a configured allowlist before passing it here.
///
/// Everything else (protocol-relative "//", "/\", javascript:, control chars) → "/".
public static class RedirectSafety
{
    public static string SafeTarget(string? target)
    {
        if (string.IsNullOrEmpty(target)) return "/";

        // Absolute http / https URL — accepted for cross-domain waiting-room deployments.
        if (target.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            target.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var c in target)
                if (c < 0x20 || c == 0x7f) return "/";
            return target;
        }

        if (target[0] != '/') return "/";                              // blocks scheme: targets
        if (target.Length > 1 && (target[1] == '/' || target[1] == '\\')) return "/"; // blocks //evil and /\evil
        foreach (var c in target)
            if (c < 0x20 || c == 0x7f) return "/";
        return target;
    }
}
