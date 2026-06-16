using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace QueueService.Tokens;

/// Stateless HMAC-SHA256 signer. Token = base64url(json) + "." + base64url(hmac).
/// Verification checks the signature only; expiry is the caller's concern.
public sealed class TokenService(string secret)
{
    private readonly byte[] _key = Encoding.UTF8.GetBytes(secret);

    public string Sign<T>(T payload)
    {
        var body = Base64Url(JsonSerializer.SerializeToUtf8Bytes(payload));
        return $"{body}.{Base64Url(Hmac(body))}";
    }

    public bool TryVerify<T>(string token, out T? payload)
    {
        payload = default;
        if (string.IsNullOrEmpty(token)) return false;
        var parts = token.Split('.');
        if (parts.Length != 2 || parts[0].Length == 0 || parts[1].Length == 0) return false;

        var expected = Base64Url(Hmac(parts[0]));
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(parts[1]), Encoding.ASCII.GetBytes(expected)))
            return false;

        try
        {
            payload = JsonSerializer.Deserialize<T>(Base64UrlDecode(parts[0]));
            return payload is not null;
        }
        catch (JsonException) { return false; }
    }

    private byte[] Hmac(string body) => HMACSHA256.HashData(_key, Encoding.ASCII.GetBytes(body));

    private static string Base64Url(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        t += (t.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        return Convert.FromBase64String(t);
    }
}
