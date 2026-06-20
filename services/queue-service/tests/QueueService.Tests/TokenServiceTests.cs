using QueueService.Tokens;
using Xunit;

public class TokenServiceTests
{
    private readonly TokenService _svc = new(new string('k', 32));

    [Fact]
    public void Sign_then_verify_round_trips_payload()
    {
        var token = new AdmissionToken("E1", "mid-1", 1000, 1600, "nonce");
        var s = _svc.Sign(token);
        Assert.True(_svc.TryVerify<AdmissionToken>(s, out var back));
        Assert.Equal(token, back);
    }

    [Fact]
    public void Tampered_body_is_rejected()
    {
        var s = _svc.Sign(new AdmissionToken("E1", "mid-1", 1, 2, "n"));
        var tampered = "x" + s; // mutate the body segment
        Assert.False(_svc.TryVerify<AdmissionToken>(tampered, out _));
    }

    [Fact]
    public void Wrong_secret_is_rejected()
    {
        var s = _svc.Sign(new AdmissionToken("E1", "mid-1", 1, 2, "n"));
        var other = new TokenService(new string('z', 32));
        Assert.False(other.TryVerify<AdmissionToken>(s, out _));
    }

    [Theory]
    [InlineData("")]
    [InlineData("no-dot")]
    [InlineData("a.b.c")]
    public void Malformed_tokens_are_rejected(string bad)
        => Assert.False(_svc.TryVerify<AdmissionToken>(bad, out _));
}
