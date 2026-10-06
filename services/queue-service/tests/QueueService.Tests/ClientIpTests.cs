using Microsoft.AspNetCore.Builder;
using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using StackExchange.Redis;
using Xunit;

/// The enqueue limiter must count real clients, not the ingress in front of them,
/// yet a client must never be able to pick its own bucket with a forged header.
[Collection("redis")]
public class ClientIpTests(RedisFixture fx)
{
    private const string TestRemoteHeader = "X-Test-Remote";

    // TestServer has no socket, so a startup filter stands in for the connection's remote address.
    private sealed class FakeRemoteAddress : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((ctx, n) =>
            {
                if (ctx.Request.Headers.TryGetValue(TestRemoteHeader, out var ip))
                    ctx.Connection.RemoteIpAddress = IPAddress.Parse(ip.ToString());
                return n();
            });
            next(app);
        };
    }

    private WebApplicationFactory<Program> Factory(params string[] trustedCidrs) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Queue:HmacSecret", new string('k', 32));
            b.UseSetting("Queue:UserIdSigningKey", new string('s', 32));
            b.UseSetting("Queue:RedisConnection", "unused");
            b.UseSetting("Queue:EnqueuePerMinutePerIp", "2");
            for (var i = 0; i < trustedCidrs.Length; i++)
                b.UseSetting($"Queue:TrustedProxyCidrs:{i}", trustedCidrs[i]);
            b.ConfigureServices(s =>
            {
                s.RemoveAll(typeof(IConnectionMultiplexer));
                s.AddSingleton(fx.Mux);
                s.AddSingleton<IStartupFilter, FakeRemoteAddress>();
            });
        });

    private static async Task<HttpStatusCode> Enqueue(HttpClient c, string remote, string? forwardedFor)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/enqueue?e=no-such-event");
        req.Headers.Add(TestRemoteHeader, remote);
        if (forwardedFor is not null) req.Headers.Add("X-Forwarded-For", forwardedFor);
        return (await c.SendAsync(req)).StatusCode; // unknown event: 404, but the limiter ran first
    }

    [Fact]
    public async Task Clients_behind_a_trusted_proxy_get_separate_buckets()
    {
        await using var f = Factory("10.0.0.0/8");
        var c = f.CreateClient();

        for (var i = 0; i < 2; i++)
        {
            Assert.NotEqual(HttpStatusCode.TooManyRequests, await Enqueue(c, "10.1.2.3", "198.51.100.1"));
            Assert.NotEqual(HttpStatusCode.TooManyRequests, await Enqueue(c, "10.1.2.3", "198.51.100.2"));
        }
        // The third request from one client is over its own limit of 2 ...
        Assert.Equal(HttpStatusCode.TooManyRequests, await Enqueue(c, "10.1.2.3", "198.51.100.1"));
        // ... while a new client behind the same proxy is untouched.
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Enqueue(c, "10.1.2.3", "198.51.100.3"));
    }

    [Fact]
    public async Task Forwarded_for_from_an_untrusted_source_cannot_pick_a_bucket()
    {
        await using var f = Factory("10.0.0.0/8");
        var c = f.CreateClient();

        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Enqueue(c, "203.0.113.9", "198.51.100.1"));
        Assert.NotEqual(HttpStatusCode.TooManyRequests, await Enqueue(c, "203.0.113.9", "198.51.100.2"));
        // Every spoofed value lands in the one bucket of the real remote address.
        Assert.Equal(HttpStatusCode.TooManyRequests, await Enqueue(c, "203.0.113.9", "198.51.100.3"));
    }

    [Fact]
    public async Task Loopback_is_not_trusted_unless_configured()
    {
        await using var f = Factory("10.0.0.0/8");
        var c = f.CreateClient();

        await Enqueue(c, "127.0.0.1", "198.51.100.1");
        await Enqueue(c, "127.0.0.1", "198.51.100.2");
        Assert.Equal(HttpStatusCode.TooManyRequests, await Enqueue(c, "127.0.0.1", "198.51.100.3"));
    }
}

public class ProxyStartupValidationTests
{
    private static Exception? Start(string environment, params string[] cidrs)
    {
        var f = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment(environment);
            b.UseSetting("Queue:RedisConnection", "localhost:6379");
            b.UseSetting("Queue:HmacSecret", new string('k', 32));
            b.UseSetting("Queue:UserIdSigningKey", new string('s', 32));
            for (var i = 0; i < cidrs.Length; i++) b.UseSetting($"Queue:TrustedProxyCidrs:{i}", cidrs[i]);
        });
        return Record.Exception(() => f.Services.GetService<object>());
    }

    // Behind an ingress every request shares its address; without the proxy list the
    // per-IP limit would throttle the whole sale as one client.
    [Fact]
    public void Outside_development_the_trusted_proxy_list_is_required()
    {
        var ex = Start("Production");
        Assert.NotNull(ex);
        Assert.Contains("TrustedProxyCidrs", ex!.ToString());
    }

    [Fact]
    public void An_invalid_cidr_fails_startup()
    {
        var ex = Start("Development", "not-a-cidr");
        Assert.NotNull(ex);
        Assert.Contains("TrustedProxyCidrs", ex!.ToString());
    }

    [Fact]
    public void A_valid_list_starts_outside_development() => Assert.Null(Start("Production", "10.0.0.0/8"));
}
