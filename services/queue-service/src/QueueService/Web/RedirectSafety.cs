namespace QueueService.Web;

/// Guards the post-admission redirect target against open-redirect / token-exfil.
///
/// Two forms are accepted:
///   1. Absolute path — starts with exactly one "/". Same-origin navigation.
///   2. Absolute http/https URL — only when its origin (scheme+host+port) appears
///      in <paramref name="allowedOrigins"/>. Use this for cross-domain deployments
///      where the waiting room runs on a separate subdomain. Empty allowlist ⇒ only
///      relative paths are accepted.
///
/// Everything else collapses to "/".
public static class RedirectSafety
{
    public static string SafeTarget(string? target, IReadOnlyList<string>? allowedOrigins = null)
    {
        if (string.IsNullOrEmpty(target)) return "/";

        // Absolute http/https URL — accepted only when the origin is explicitly allowlisted.
        if (target.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            target.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            if (allowedOrigins is { Count: > 0 } &&
                Uri.TryCreate(target, UriKind.Absolute, out var uri))
            {
                var origin = uri.GetLeftPart(UriPartial.Authority);
                if (allowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase))
                {
                    foreach (var c in target)
                        if (c < 0x20 || c == 0x7f) return "/";
                    return target;
                }
            }
            return "/";
        }

        if (target[0] != '/') return "/";                              // blocks scheme: targets
        if (target.Length > 1 && (target[1] == '/' || target[1] == '\\')) return "/"; // blocks //evil and /\evil
        foreach (var c in target)
            if (c < 0x20 || c == 0x7f) return "/";
        return target;
    }
}
