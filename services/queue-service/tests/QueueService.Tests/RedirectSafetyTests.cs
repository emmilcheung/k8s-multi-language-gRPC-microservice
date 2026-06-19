using QueueService.Web;
using Xunit;

public class RedirectSafetyTests
{
    [Theory]
    [InlineData("/tickets/123", "/tickets/123")]
    [InlineData("/tickets/123?qpass=x", "/tickets/123?qpass=x")]
    [InlineData("/", "/")]
    public void Allows_same_origin_relative_paths(string input, string expected)
        => Assert.Equal(expected, RedirectSafety.SafeTarget(input));

    [Theory]
    [InlineData("https://evil.com")]        // absolute URL -> off-origin
    [InlineData("http://evil.com")]
    [InlineData("//evil.com")]              // protocol-relative
    [InlineData("/\\evil.com")]             // backslash trick (browsers treat as //)
    [InlineData("javascript:alert(1)")]     // scheme -> not path-absolute
    [InlineData("data:text/html,x")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("/foo\r\nLocation: evil")]  // CRLF / header-split style
    public void Collapses_unsafe_targets_to_root(string? input)
        => Assert.Equal("/", RedirectSafety.SafeTarget(input));

    // ── Allowlist overload ────────────────────────────────────────────────────

    [Theory]
    [InlineData("http://app.example.com/tickets/123",  "http://app.example.com")]
    [InlineData("https://app.example.com/",            "https://app.example.com")]
    [InlineData("http://localhost:4000/path?q=1",      "http://localhost:4000")]
    public void Allows_absolute_url_when_origin_is_allowlisted(string input, string allowedOrigin)
        => Assert.Equal(input, RedirectSafety.SafeTarget(input, [allowedOrigin]));

    [Theory]
    [InlineData("http://evil.com",  "http://app.example.com")] // wrong origin
    [InlineData("http://evil.com",  null)]                     // empty allowlist
    [InlineData("https://evil.com", "https://app.example.com")]
    public void Rejects_absolute_url_not_in_allowlist(string input, string? allowedOrigin)
        => Assert.Equal("/", RedirectSafety.SafeTarget(input,
            allowedOrigin is null ? null : [allowedOrigin]));
}
