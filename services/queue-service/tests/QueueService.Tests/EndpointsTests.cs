using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using QueueService.Queue;
using StackExchange.Redis;
using Xunit;

public class StartupValidationTests
{
    [Fact]
    public void Startup_throws_when_hmac_secret_missing()
    {
        var factory = new WebApplicationFactory<Program>()
            .WithWebHostBuilder(b => b.UseSetting("Queue:RedisConnection", "localhost:6379"));
        // Queue:HmacSecret deliberately not set

        var ex = Record.Exception(() => factory.Services.GetService<object>());
        Assert.NotNull(ex); // ValidateOnStart surfaces as OptionsValidationException
    }
}

[Collection("redis")]
public class QueueApiTests(RedisFixture fx)
{
    private WebApplicationFactory<Program> Factory() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Queue:HmacSecret", new string('k', 32));
            b.UseSetting("Queue:RedisConnection", "unused"); // overridden by DI below
            b.ConfigureServices(s =>
            {
                s.RemoveAll(typeof(IConnectionMultiplexer));
                s.AddSingleton(fx.Mux);
            });
        });

    [Fact]
    public async Task Serving_endpoint_is_publicly_cacheable()
    {
        await using var f = Factory();
        var eid = await SeedEvent(f, openSecondsAgo: 10, rate: 1); // rate 1 -> robust to sub-second jitter
        var res = await f.CreateClient().GetAsync($"/api/serving?e={eid}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("max-age", res.Headers.CacheControl!.ToString());
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(10, body.GetProperty("serving").GetInt64()); // 1/s * ~10s, floored
    }

    [Fact]
    public async Task Enqueue_sets_ticket_cookie_and_claim_yields_token_after_open()
    {
        await using var f = Factory();
        var eid = await SeedEvent(f, openSecondsAgo: 5, rate: 100); // already open -> late path
        var client = f.CreateClient();

        var enq = await client.PostAsync($"/api/enqueue?e={eid}", null);
        Assert.Equal(HttpStatusCode.OK, enq.StatusCode);
        Assert.Contains(enq.Headers.GetValues("Set-Cookie"), c => c.StartsWith("qq_ticket="));

        var claim = await client.PostAsync($"/api/claim?e={eid}", null);
        Assert.Equal(HttpStatusCode.OK, claim.StatusCode);
        var body = await claim.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(string.IsNullOrEmpty(body.GetProperty("token").GetString()));
    }

    [Fact]
    public async Task Claim_without_ticket_is_rejected()
    {
        await using var f = Factory();
        var eid = await SeedEvent(f, openSecondsAgo: 5, rate: 100);
        var res = await f.CreateClient().PostAsync($"/api/claim?e={eid}", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Wait_page_renders_with_poller_and_event_data()
    {
        await using var f = Factory();
        var eid = await SeedEvent(f, openSecondsAgo: -120, rate: 50); // opens in 2 min
        var html = await f.CreateClient().GetStringAsync($"/wait?e={eid}&target=%2Ftickets%2F123");

        Assert.Contains("id=\"countdown\"", html);
        Assert.Contains("/js/wait.js", html);
        Assert.Contains(eid, html);
    }

    private static async Task<string> SeedEvent(WebApplicationFactory<Program> f, int openSecondsAgo, double rate)
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var store = new QueueStore((IConnectionMultiplexer)f.Services.GetService(typeof(IConnectionMultiplexer))!);
        var t0 = DateTimeOffset.UtcNow.AddSeconds(-openSecondsAgo);
        await store.SetConfigAsync(new EventConfig(eid, t0, rate, true, null));
        return eid;
    }
}
