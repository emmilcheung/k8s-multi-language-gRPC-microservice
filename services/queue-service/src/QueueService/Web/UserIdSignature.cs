using System.Security.Cryptography;
using System.Text;

namespace QueueService.Web;

/// Checks the X-User-Id-Sig header Kong adds after it validates the caller's
/// JWT: base64(HMAC-SHA256(key, "<userId>|<unix minute>")), accepted for the
/// current or the previous minute. Same format as every other consuming
/// service (docs/06-security.md). Unlike those, an empty key is not a pass:
/// startup refuses it (QueueOptions.UserIdSigningKey).
public sealed class UserIdSignature(string key, TimeProvider clock)
{
    private readonly byte[] _key = Encoding.UTF8.GetBytes(key);

    public bool IsValid(string? userId, string? signature)
    {
        if (string.IsNullOrEmpty(userId) || string.IsNullOrEmpty(signature)) return false;
        var minute = clock.GetUtcNow().ToUnixTimeSeconds() / 60;
        var given = Encoding.ASCII.GetBytes(signature);
        return Matches(userId, minute, given) | Matches(userId, minute - 1, given);
    }

    private bool Matches(string userId, long minute, byte[] given) =>
        CryptographicOperations.FixedTimeEquals(given, Encoding.ASCII.GetBytes(Convert.ToBase64String(
            HMACSHA256.HashData(_key, Encoding.UTF8.GetBytes($"{userId}|{minute}")))));
}
