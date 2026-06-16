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
}
