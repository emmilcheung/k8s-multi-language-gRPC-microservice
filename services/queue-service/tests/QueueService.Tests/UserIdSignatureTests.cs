using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Time.Testing;
using QueueService.Web;
using Xunit;

// Kong signs the caller's user id (X-User-Id-Sig) with the same key and format
// every consuming service checks: base64(HMAC-SHA256(key, "<userId>|<minute>")).
// Redeem trusts X-User-Id only through this check, because the queue host is
// also reachable directly, without Kong in front of it.
public class UserIdSignatureTests
{
    private const string Key = "user-id-signing-key-0123456789abcdef";
    private static readonly DateTimeOffset Now = new(2026, 10, 4, 12, 0, 30, TimeSpan.Zero);

    private static string Sign(string userId, long minute, string key = Key) =>
        Convert.ToBase64String(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes($"{userId}|{minute}")));

    private static readonly long Minute = Now.ToUnixTimeSeconds() / 60;
    private readonly UserIdSignature _sig = new(Key, new FakeTimeProvider(Now));

    [Fact]
    public void Accepts_a_signature_from_the_current_minute() =>
        Assert.True(_sig.IsValid("user-a", Sign("user-a", Minute)));

    [Fact]
    public void Accepts_a_signature_from_the_previous_minute_across_the_boundary() =>
        Assert.True(_sig.IsValid("user-a", Sign("user-a", Minute - 1)));

    [Fact]
    public void Rejects_a_signature_older_than_the_previous_minute() =>
        Assert.False(_sig.IsValid("user-a", Sign("user-a", Minute - 2)));

    [Fact]
    public void Rejects_a_signature_for_another_user() =>
        Assert.False(_sig.IsValid("user-b", Sign("user-a", Minute)));

    [Fact]
    public void Rejects_a_signature_made_with_another_key() =>
        Assert.False(_sig.IsValid("user-a", Sign("user-a", Minute, "some-other-key-0123456789abcdefgh")));

    [Theory]
    [InlineData(null, "x")]
    [InlineData("", "x")]
    [InlineData("user-a", null)]
    [InlineData("user-a", "")]
    public void Rejects_a_missing_user_or_signature(string? userId, string? signature) =>
        Assert.False(_sig.IsValid(userId, signature));
}
