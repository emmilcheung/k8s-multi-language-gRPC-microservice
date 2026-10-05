using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using QueueService.Queue;
using StackExchange.Redis;
using Xunit;

[Collection("redis")]
public class AdminApiTests(RedisFixture fx)
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);
    private static readonly string Key = new('a', 40);
    private const int AdminPort = 9090;

    // TestServer has no sockets, so stand in for the listener: the local port is what the
    // Host header says, as it would be for a request that arrived on that port.
    private sealed class LocalPortFromHost : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((ctx, n) => { ctx.Connection.LocalPort = ctx.Request.Host.Port ?? 80; return n(ctx); });
            next(app);
        };
    }

    private static HttpClient AdminClient(WebApplicationFactory<Program> f)
        => f.CreateClient(new() { BaseAddress = new Uri($"http://localhost:{AdminPort}") });

    private WebApplicationFactory<Program> Factory(FakeTimeProvider clock, string? adminKey) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Queue:HmacSecret", new string('k', 32));
            b.UseSetting("Queue:UserIdSigningKey", new string('s', 32));
            b.UseSetting("Queue:RedisConnection", "unused");
            if (adminKey is not null)
            {
                b.UseSetting("Queue:AdminApiKey", adminKey);
                b.UseSetting("Queue:AdminPort", AdminPort.ToString());
            }
            b.ConfigureServices(s =>
            {
                s.AddSingleton<IStartupFilter, LocalPortFromHost>();
                s.RemoveAll(typeof(IConnectionMultiplexer));
                s.AddSingleton(fx.Mux);
                s.RemoveAll<TimeProvider>();
                s.AddSingleton<TimeProvider>(clock);
            });
        });

    private async Task<string> Seed(double rate = 100)
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        await new QueueStore(fx.Mux).SetConfigAsync(new EventConfig(eid, T0, rate, true, null));
        return eid;
    }

    private static HttpRequestMessage Post(string path, object body, string? key = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        if (key is not null) req.Headers.Add("X-Queue-Admin-Key", key);
        return req;
    }

    private static async Task<JsonElement> Serving(HttpClient c, FakeTimeProvider clock, string eid)
    {
        clock.Advance(TimeSpan.FromMilliseconds(1100)); // past the snapshot refresh
        await c.GetAsync($"/api/serving?e={eid}"); // an expired snapshot is answered as is while the refresh runs behind it
        await Task.Delay(100);
        return await c.GetFromJsonAsync<JsonElement>($"/api/serving?e={eid}");
    }

    [Theory]
    [InlineData("rate", "{\"rate\":5}")]
    [InlineData("paused", "{\"paused\":true}")]
    [InlineData("sold-out", "{\"soldOut\":true}")]
    public async Task Admin_routes_refuse_a_missing_or_wrong_key(string action, string json)
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var c = AdminClient(f);
        var eid = await Seed();
        var body = JsonSerializer.Deserialize<JsonElement>(json);

        var none = await c.SendAsync(Post($"/api/admin/events/{eid}/{action}", body));
        var wrong = await c.SendAsync(Post($"/api/admin/events/{eid}/{action}", body, new string('b', 40)));
        var shorter = await c.SendAsync(Post($"/api/admin/events/{eid}/{action}", body, "a"));

        Assert.Equal(HttpStatusCode.Unauthorized, none.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, shorter.StatusCode);
        var s = await Serving(c, clock, eid);
        Assert.Equal(100, s.GetProperty("rate").GetDouble()); // nothing was applied
        Assert.False(s.GetProperty("paused").GetBoolean());
        Assert.False(s.GetProperty("soldOut").GetBoolean());
    }

    private sealed class CaptureLogs(List<string> lines) : ILoggerProvider, ILogger
    {
        public ILogger CreateLogger(string categoryName) => this;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex, Func<TState, Exception?, string> fmt)
        { lock (lines) lines.Add($"{level}: {fmt(state, ex)}"); }
        public void Dispose() { }
    }

    // Guessing the key is the attack on this port, so a rejected attempt must leave a trace
    // an operator can alert on, without writing down what was guessed.
    [Fact]
    public async Task A_rejected_admin_key_is_logged_as_a_warning_without_the_key()
    {
        var lines = new List<string>();
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key).WithWebHostBuilder(b =>
            b.ConfigureLogging(l => l.AddProvider(new CaptureLogs(lines))));
        var c = AdminClient(f);
        var eid = await Seed();
        const string guess = "super-secret-guess-super-secret-guess";

        await c.SendAsync(Post($"/api/admin/events/{eid}/paused", new { paused = true }, guess));

        string[] seen; lock (lines) seen = lines.ToArray();
        var line = Assert.Single(seen, l => l.StartsWith("Warning:") && l.Contains("/paused"));
        Assert.Contains(eid, line);
        Assert.DoesNotContain(guess, string.Join('\n', seen));
    }

    // The ingress forwards the public port to the internet; the admin routes must not be there.
    [Fact]
    public async Task Admin_routes_are_not_reachable_on_the_public_port_even_with_the_right_key()
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var eid = await Seed();
        var publicClient = f.CreateClient(); // http://localhost, not the admin port

        var res = await publicClient.SendAsync(Post($"/api/admin/events/{eid}/paused", new { paused = true }, Key));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.False((await Serving(publicClient, clock, eid)).GetProperty("paused").GetBoolean());

        var onAdmin = await AdminClient(f).SendAsync(Post($"/api/admin/events/{eid}/paused", new { paused = true }, Key));
        Assert.Equal(HttpStatusCode.OK, onAdmin.StatusCode);
        Assert.True((await Serving(publicClient, clock, eid)).GetProperty("paused").GetBoolean());
    }

    [Fact]
    public async Task Admin_routes_do_not_exist_when_no_key_is_configured()
    {
        var clock = new FakeTimeProvider(T0);
        await using var f = Factory(clock, adminKey: null);
        var eid = await Seed();
        var res = await AdminClient(f).SendAsync(Post($"/api/admin/events/{eid}/paused", new { paused = true }, Key));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Rate_change_applies_to_serving_after_the_cache_interval_without_a_jump()
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var c = AdminClient(f);
        var eid = await Seed(rate: 100);
        Assert.Equal(1110, (await Serving(c, clock, eid)).GetProperty("serving").GetInt64()); // 11.1 s at 100/s

        var res = await c.SendAsync(Post($"/api/admin/events/{eid}/rate", new { rate = 10 }, Key));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var after = await Serving(c, clock, eid);
        Assert.Equal(10, after.GetProperty("rate").GetDouble());
        Assert.InRange(after.GetProperty("serving").GetInt64(), 1110 + 1, 1110 + 20); // continues from 1110, now at 10/s
    }

    [Theory]
    [InlineData("{\"rate\":0}")]
    [InlineData("{\"rate\":-3}")]
    [InlineData("{}")]
    public async Task Rate_must_be_positive(string json)
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var eid = await Seed();
        var res = await AdminClient(f).SendAsync(Post($"/api/admin/events/{eid}/rate",
            JsonSerializer.Deserialize<JsonElement>(json), Key));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    // A huge rate would overflow the admitted count, which is a long.
    [Theory]
    [InlineData("{\"rate\":1e30}")]
    [InlineData("{\"rate\":100001}")]
    public async Task Rate_above_the_ceiling_is_refused_and_changes_nothing(string json)
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var c = AdminClient(f);
        var eid = await Seed(rate: 100);
        var res = await c.SendAsync(Post($"/api/admin/events/{eid}/rate",
            JsonSerializer.Deserialize<JsonElement>(json), Key));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal(100, (await Serving(c, clock, eid)).GetProperty("rate").GetDouble());
    }

    [Fact]
    public async Task Rate_at_the_ceiling_is_accepted()
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var eid = await Seed();
        var res = await AdminClient(f).SendAsync(Post($"/api/admin/events/{eid}/rate", new { rate = 100000 }, Key));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Pause_stops_serving_and_blocks_claims_until_resumed()
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var c = AdminClient(f);
        var eid = await Seed(rate: 100);
        await c.PostAsync($"/api/enqueue?e={eid}", null);

        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(Post($"/api/admin/events/{eid}/paused", new { paused = true }, Key))).StatusCode);
        var paused = await Serving(c, clock, eid);
        Assert.True(paused.GetProperty("paused").GetBoolean());
        var frozen = paused.GetProperty("serving").GetInt64();
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsync($"/api/claim?e={eid}", null)).StatusCode);
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(frozen, (await Serving(c, clock, eid)).GetProperty("serving").GetInt64());

        await c.SendAsync(Post($"/api/admin/events/{eid}/paused", new { paused = false }, Key));
        var resumed = await Serving(c, clock, eid);
        Assert.False(resumed.GetProperty("paused").GetBoolean());
        Assert.InRange(resumed.GetProperty("serving").GetInt64(), frozen, frozen + 200);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync($"/api/claim?e={eid}", null)).StatusCode);
    }

    [Fact]
    public async Task Sold_out_shows_in_serving_and_refuses_claims()
    {
        var clock = new FakeTimeProvider(T0.AddSeconds(10));
        await using var f = Factory(clock, Key);
        var c = AdminClient(f);
        var eid = await Seed();
        await c.PostAsync($"/api/enqueue?e={eid}", null);

        await c.SendAsync(Post($"/api/admin/events/{eid}/sold-out", new { soldOut = true }, Key));

        Assert.True((await Serving(c, clock, eid)).GetProperty("soldOut").GetBoolean());
        var claim = await c.PostAsync($"/api/claim?e={eid}", null);
        Assert.Equal(HttpStatusCode.Conflict, claim.StatusCode);
        Assert.True((await claim.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("soldOut").GetBoolean());
    }

    [Fact]
    public async Task An_unknown_event_is_404()
    {
        var clock = new FakeTimeProvider(T0);
        await using var f = Factory(clock, Key);
        var res = await AdminClient(f).SendAsync(Post("/api/admin/events/nope/paused", new { paused = true }, Key));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}

public class PassLifetimeStartupTests
{
    private static Exception? Start(Action<IWebHostBuilder> more)
    {
        var f = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("Queue:RedisConnection", "localhost:6379");
            b.UseSetting("Queue:HmacSecret", new string('k', 32));
            b.UseSetting("Queue:UserIdSigningKey", new string('s', 32));
            more(b);
        });
        return Record.Exception(() => f.Services.GetService<object>());
    }

    // A seat is held for 10 minutes; a pass that expires first would let a buyer
    // hold seats they can no longer pay for.
    [Theory]
    [InlineData("600")]
    [InlineData("300")]
    public void A_pass_that_does_not_outlive_the_seat_hold_fails_startup(string ttl)
    {
        var ex = Start(b => b.UseSetting("Queue:AdmissionTtlSeconds", ttl));
        Assert.NotNull(ex);
        Assert.Contains("seat hold", ex!.ToString());
    }

    [Fact]
    public void A_pass_longer_than_the_seat_hold_starts() =>
        Assert.Null(Start(b => b.UseSetting("Queue:AdmissionTtlSeconds", "601")));

    [Fact]
    public void A_short_admin_key_fails_startup()
    {
        var ex = Start(b => b.UseSetting("Queue:AdminApiKey", "short"));
        Assert.NotNull(ex);
        Assert.Contains("AdminApiKey", ex!.ToString());
    }

    // Without a separate port the admin routes would have nowhere safe to be answered.
    [Fact]
    public void An_admin_key_without_an_admin_port_fails_startup()
    {
        var ex = Start(b => b.UseSetting("Queue:AdminApiKey", new string('a', 40)));
        Assert.NotNull(ex);
        Assert.Contains("AdminPort", ex!.ToString());
    }

    [Fact]
    public void An_admin_port_equal_to_the_public_port_fails_startup()
    {
        var ex = Start(b =>
        {
            b.UseSetting("HTTP_PORTS", "8080");
            b.UseSetting("Queue:AdminApiKey", new string('a', 40));
            b.UseSetting("Queue:AdminPort", "8080");
        });
        Assert.NotNull(ex);
        Assert.Contains("AdminPort", ex!.ToString());
    }

    [Fact]
    public void An_admin_key_with_a_separate_admin_port_starts() =>
        Assert.Null(Start(b =>
        {
            b.UseSetting("HTTP_PORTS", "8080");
            b.UseSetting("Queue:AdminApiKey", new string('a', 40));
            b.UseSetting("Queue:AdminPort", "9090");
        }));

    [Theory]
    [InlineData("not a url")]
    [InlineData("http://venue/availability")] // no {eid}
    [InlineData("ftp://venue/{eid}")]
    public void A_bad_venue_url_fails_startup(string url)
    {
        var ex = Start(b => b.UseSetting("Queue:VenueAvailabilityUrl", url));
        Assert.NotNull(ex);
        Assert.Contains("VenueAvailabilityUrl", ex!.ToString());
    }

    [Fact]
    public void A_venue_url_with_an_event_placeholder_starts() =>
        Assert.Null(Start(b => b.UseSetting("Queue:VenueAvailabilityUrl", "http://venue:8080/internal/tickets/{eid}/availability")));
}
