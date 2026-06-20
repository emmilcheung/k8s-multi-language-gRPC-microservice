# Virtual Waiting Room — Queue-Service Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, vendor-neutral ASP.NET Core 10 queue-service that meters onsale traffic by pure time-math rate-based admission, with a pre-queue randomized draw, an HMAC token/cookie contract, a server-rendered waiting page, and a local Docker compose group — fully unit/integration tested and runnable on a laptop.

**Architecture:** One ASP.NET Core process. Pure logic (`AdmissionCalculator`, `TokenService`) is unit-tested in isolation; Redis state (`QueueStore`) and orchestration (`QueueCoordinator`) are integration-tested against a Testcontainers Redis; HTTP is integration-tested via `WebApplicationFactory`. Admission is `serving(t) = floor(rate · (t − T0))` — no ticker, no shared mutable counter. Time is injected via `TimeProvider` so admission boundaries are deterministically testable.

**Tech Stack:** .NET 10 (LTS), C# 14, Razor Pages + Minimal APIs, `StackExchange.Redis` (only runtime dependency). Tests: xUnit, `Microsoft.AspNetCore.Mvc.Testing`, `Testcontainers.Redis`, `Microsoft.Extensions.TimeProvider.Testing`. Docker: chiseled non-root multi-stage.

**Design source:** [`docs/superpowers/specs/2026-06-16-virtual-waiting-room-design.md`](../specs/2026-06-16-virtual-waiting-room-design.md). This plan is the "how"; consult the spec for the "why".

**Out of scope (later plans):** Next.js middleware + Kong backstop + Playwright E2E (Plan 2); K8s `queue-system` cluster + k6 load extension (Plan 3).

---

## File Structure

```
services/queue-service/
  QueueService.sln
  src/QueueService/
    QueueService.csproj
    Program.cs                     # host wiring, fail-loud config, endpoint + page mapping
    appsettings.json               # default config (secret/redis come from env in real runs)
    Options/QueueOptions.cs        # bound + DataAnnotations-validated config
    Admission/AdmissionCalculator.cs  # pure serving(t)/isAdmitted/wait math
    Tokens/TokenModels.cs          # PreQueueTicket, AdmissionToken records
    Tokens/TokenService.cs         # HMAC-SHA256 sign/verify (generic)
    Queue/EventConfig.cs           # EventConfig record
    Queue/QueueStore.cs            # Redis ops (ZADD/ZRANK/ZCARD/INCR/HASH)
    Queue/QueueCoordinator.cs      # orchestration used by both API + Razor page
    Queue/Results.cs               # EnqueueResult/StatusResult/ClaimResult records
    Endpoints/QueueEndpoints.cs    # MapQueueApi extension (enqueue/serving/status/claim/admin)
    Pages/Wait.cshtml(.cs)         # server-rendered waiting page
    wwwroot/js/wait.js             # ~30-line vanilla poller
    Dockerfile
  tests/QueueService.Tests/
    QueueService.Tests.csproj
    AdmissionCalculatorTests.cs
    TokenServiceTests.cs
    QueueStoreTests.cs             # Testcontainers Redis
    QueueCoordinatorTests.cs       # Testcontainers Redis + FakeTimeProvider
    EndpointsTests.cs              # WebApplicationFactory + Testcontainers Redis
    RedisFixture.cs                # shared Testcontainers collection fixture
docker-compose.queue.yml           # repo-root: isolated compose group (own ports + own Redis)
```

**Type contract (defined once, referenced everywhere):**

```csharp
// Queue/EventConfig.cs
public sealed record EventConfig(string Eid, DateTimeOffset T0, double Rate, bool Armed, long? PreQueueSize);

// Tokens/TokenModels.cs
public sealed record PreQueueTicket(string Eid, string Mid, double R, long? Pos, string Phase, long Iat);
public sealed record AdmissionToken(string Eid, string Mid, long Iat, long Exp, string Nonce);

// Queue/Results.cs
public sealed record EnqueueResult(PreQueueTicket Ticket, string Phase, long? Position, EventConfig Config);
public sealed record StatusResult(PreQueueTicket Ticket, long Position, long Serving, bool Admitted, double WaitSeconds);
public sealed record ClaimResult(bool Admitted, string? Token, PreQueueTicket Ticket);
```

Phase values are the literals `"pre"` and `"late"`. `Mid` is a GUID string. `Eid` is the event id from the `e` query param.

---

## Task 1: Scaffold solution, project, and test project

**Files:**
- Create: `services/queue-service/src/QueueService/QueueService.csproj`
- Create: `services/queue-service/src/QueueService/Program.cs`
- Create: `services/queue-service/src/QueueService/appsettings.json`
- Create: `services/queue-service/tests/QueueService.Tests/QueueService.Tests.csproj`
- Create: `services/queue-service/QueueService.sln`

- [ ] **Step 1: Create the solution and projects**

Run:
```bash
cd services/queue-service
dotnet new sln -n QueueService
dotnet new web -n QueueService -o src/QueueService -f net10.0
dotnet new xunit -n QueueService.Tests -o tests/QueueService.Tests -f net10.0
dotnet sln add src/QueueService/QueueService.csproj tests/QueueService.Tests/QueueService.Tests.csproj
dotnet add tests/QueueService.Tests/QueueService.Tests.csproj reference src/QueueService/QueueService.csproj
```
Expected: solution + two projects created, reference added.

- [ ] **Step 2: Add runtime + test packages**

Run:
```bash
dotnet add src/QueueService/QueueService.csproj package StackExchange.Redis
dotnet add tests/QueueService.Tests/QueueService.Tests.csproj package Microsoft.AspNetCore.Mvc.Testing
dotnet add tests/QueueService.Tests/QueueService.Tests.csproj package Testcontainers.Redis
dotnet add tests/QueueService.Tests/QueueService.Tests.csproj package Microsoft.Extensions.TimeProvider.Testing
```
Expected: packages restore with no errors.

- [ ] **Step 3: Replace `src/QueueService/QueueService.csproj` contents**

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="StackExchange.Redis" Version="2.*" />
  </ItemGroup>
</Project>
```

- [ ] **Step 4: Write a minimal `Program.cs` (expanded in later tasks)**

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHealthChecks();

var app = builder.Build();
app.MapHealthChecks("/healthz");
app.MapGet("/", () => Results.Ok("queue-service"));
app.Run();

public partial class Program; // exposed for WebApplicationFactory in tests
```

- [ ] **Step 5: Write `appsettings.json`**

```json
{
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" } },
  "Queue": {
    "AdmissionTtlSeconds": 600,
    "SlidingGraceSeconds": 60
  }
}
```
(`HmacSecret` and `RedisConnection` are intentionally absent — they must come from env so startup fails loud if unset; see Task 2.)

- [ ] **Step 6: Verify it builds and runs**

Run: `dotnet build`
Expected: Build succeeded, 0 errors.

- [ ] **Step 7: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): scaffold queue-service solution and test project"
```

---

## Task 2: Config options with fail-loud validation

**Files:**
- Create: `services/queue-service/src/QueueService/Options/QueueOptions.cs`
- Modify: `services/queue-service/src/QueueService/Program.cs`
- Test: `services/queue-service/tests/QueueService.Tests/EndpointsTests.cs` (startup-failure test)

- [ ] **Step 1: Write the failing test (startup fails when secret missing)**

Create `tests/QueueService.Tests/EndpointsTests.cs`:
```csharp
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `dotnet test --filter Startup_throws_when_hmac_secret_missing`
Expected: FAIL (no validation wired yet — startup currently succeeds).

- [ ] **Step 3: Write `Options/QueueOptions.cs`**

```csharp
using System.ComponentModel.DataAnnotations;

namespace QueueService.Options;

public sealed class QueueOptions
{
    public const string SectionName = "Queue";

    [Required, MinLength(32)]
    public string HmacSecret { get; set; } = string.Empty;

    [Required]
    public string RedisConnection { get; set; } = string.Empty;

    [Range(1, 86400)]
    public int AdmissionTtlSeconds { get; set; } = 600;

    [Range(1, 3600)]
    public int SlidingGraceSeconds { get; set; } = 60;
}
```

- [ ] **Step 4: Wire options + ValidateOnStart in `Program.cs`**

Replace the body above the `var app = builder.Build();` line with:
```csharp
using QueueService.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<QueueOptions>()
    .Bind(builder.Configuration.GetSection(QueueOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddHealthChecks();
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `dotnet test --filter Startup_throws_when_hmac_secret_missing`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): fail-loud config validation for HMAC secret and Redis"
```

---

## Task 3: AdmissionCalculator (pure time-math)

**Files:**
- Create: `services/queue-service/src/QueueService/Admission/AdmissionCalculator.cs`
- Test: `services/queue-service/tests/QueueService.Tests/AdmissionCalculatorTests.cs`

- [ ] **Step 1: Write the failing tests**

Create `tests/QueueService.Tests/AdmissionCalculatorTests.cs`:
```csharp
using QueueService.Admission;
using Xunit;

public class AdmissionCalculatorTests
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);

    [Fact] public void Serving_is_zero_before_T0()
        => Assert.Equal(0, AdmissionCalculator.Serving(T0.AddSeconds(-5), T0, rate: 100));

    [Fact] public void Serving_grows_with_elapsed_time_times_rate()
        => Assert.Equal(1000, AdmissionCalculator.Serving(T0.AddSeconds(10), T0, rate: 100));

    [Theory]
    [InlineData(999, 1000, true)]
    [InlineData(1000, 1000, false)]
    public void Position_admitted_when_strictly_below_serving(long pos, long serving, bool expected)
        => Assert.Equal(expected, AdmissionCalculator.IsAdmitted(pos, serving));

    [Fact] public void Wait_is_remaining_positions_over_rate()
        => Assert.Equal(5.0, AdmissionCalculator.EstimatedWaitSeconds(position: 1500, serving: 1000, rate: 100), 3);

    [Fact] public void Wait_is_zero_when_already_admitted()
        => Assert.Equal(0.0, AdmissionCalculator.EstimatedWaitSeconds(position: 10, serving: 1000, rate: 100));
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `dotnet test --filter AdmissionCalculatorTests`
Expected: FAIL (type does not exist).

- [ ] **Step 3: Implement `Admission/AdmissionCalculator.cs`**

```csharp
namespace QueueService.Admission;

/// Rate-based admission math. serving(t) = floor(rate * seconds since T0), 0 before T0.
public static class AdmissionCalculator
{
    public static long Serving(DateTimeOffset now, DateTimeOffset t0, double rate)
    {
        if (rate <= 0) throw new ArgumentOutOfRangeException(nameof(rate));
        var elapsed = (now - t0).TotalSeconds;
        return elapsed <= 0 ? 0 : (long)Math.Floor(rate * elapsed);
    }

    // 0-based position is admitted once strictly less than the served count.
    public static bool IsAdmitted(long position, long serving) => position < serving;

    public static double EstimatedWaitSeconds(long position, long serving, double rate)
    {
        if (rate <= 0) throw new ArgumentOutOfRangeException(nameof(rate));
        var ahead = position - serving;
        return ahead <= 0 ? 0 : ahead / rate;
    }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `dotnet test --filter AdmissionCalculatorTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): pure rate-based admission calculator"
```

---

## Task 4: TokenService + token models (HMAC-SHA256)

**Files:**
- Create: `services/queue-service/src/QueueService/Tokens/TokenModels.cs`
- Create: `services/queue-service/src/QueueService/Tokens/TokenService.cs`
- Test: `services/queue-service/tests/QueueService.Tests/TokenServiceTests.cs`

- [ ] **Step 1: Write the failing tests**

Create `tests/QueueService.Tests/TokenServiceTests.cs`:
```csharp
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `dotnet test --filter TokenServiceTests`
Expected: FAIL (types do not exist).

- [ ] **Step 3: Implement `Tokens/TokenModels.cs`**

```csharp
namespace QueueService.Tokens;

public sealed record PreQueueTicket(string Eid, string Mid, double R, long? Pos, string Phase, long Iat);
public sealed record AdmissionToken(string Eid, string Mid, long Iat, long Exp, string Nonce);
```

- [ ] **Step 4: Implement `Tokens/TokenService.cs`**

```csharp
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
```

- [ ] **Step 5: Run to confirm pass**

Run: `dotnet test --filter TokenServiceTests`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): HMAC-SHA256 token sign/verify with constant-time compare"
```

---

## Task 5: QueueStore (Redis state) + shared Testcontainers fixture

**Files:**
- Create: `services/queue-service/src/QueueService/Queue/EventConfig.cs`
- Create: `services/queue-service/src/QueueService/Queue/QueueStore.cs`
- Test: `services/queue-service/tests/QueueService.Tests/RedisFixture.cs`
- Test: `services/queue-service/tests/QueueService.Tests/QueueStoreTests.cs`

- [ ] **Step 1: Write the shared Redis fixture**

Create `tests/QueueService.Tests/RedisFixture.cs`:
```csharp
using StackExchange.Redis;
using Testcontainers.Redis;
using Xunit;

public sealed class RedisFixture : IAsyncLifetime
{
    private readonly RedisContainer _container = new RedisBuilder().Build();
    public IConnectionMultiplexer Mux { get; private set; } = default!;

    public async Task InitializeAsync()
    {
        await _container.StartAsync();
        Mux = await ConnectionMultiplexer.ConnectAsync(_container.GetConnectionString());
    }

    public async Task DisposeAsync()
    {
        await Mux.DisposeAsync();
        await _container.DisposeAsync();
    }
}

[CollectionDefinition("redis")]
public sealed class RedisCollection : ICollectionFixture<RedisFixture>;
```

- [ ] **Step 2: Write the failing QueueStore tests**

Create `tests/QueueService.Tests/QueueStoreTests.cs`:
```csharp
using QueueService.Queue;
using StackExchange.Redis;
using Xunit;

[Collection("redis")]
public class QueueStoreTests(RedisFixture fx)
{
    private QueueStore NewStore(out string eid)
    {
        eid = "E-" + Guid.NewGuid().ToString("N"); // isolate keys per test
        return new QueueStore(fx.Mux);
    }

    [Fact]
    public async Task Config_round_trips()
    {
        var store = NewStore(out var eid);
        var t0 = new DateTimeOffset(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);
        await store.SetConfigAsync(new EventConfig(eid, t0, 100, true, null));

        var cfg = await store.GetConfigAsync(eid);
        Assert.NotNull(cfg);
        Assert.Equal(t0, cfg!.T0);
        Assert.Equal(100, cfg.Rate);
        Assert.True(cfg.Armed);
        Assert.Null(cfg.PreQueueSize);
    }

    [Fact]
    public async Task PreQueue_rank_reflects_random_score_order()
    {
        var store = NewStore(out var eid);
        await store.EnqueuePreQueueAsync(eid, "low", 0.10);
        await store.EnqueuePreQueueAsync(eid, "high", 0.90);
        await store.EnqueuePreQueueAsync(eid, "mid", 0.50);

        Assert.Equal(0, await store.RankInPreQueueAsync(eid, "low"));
        Assert.Equal(1, await store.RankInPreQueueAsync(eid, "mid"));
        Assert.Equal(2, await store.RankInPreQueueAsync(eid, "high"));
    }

    [Fact]
    public async Task Reenqueue_keeps_first_score()
    {
        var store = NewStore(out var eid);
        await store.EnqueuePreQueueAsync(eid, "m", 0.20);
        await store.EnqueuePreQueueAsync(eid, "m", 0.99); // must be ignored (NX)
        await store.EnqueuePreQueueAsync(eid, "other", 0.50);

        Assert.Equal(0, await store.RankInPreQueueAsync(eid, "m"));
    }

    [Fact]
    public async Task Freeze_size_is_idempotent_and_late_positions_follow_it()
    {
        var store = NewStore(out var eid);
        await store.EnqueuePreQueueAsync(eid, "a", 0.1);
        await store.EnqueuePreQueueAsync(eid, "b", 0.2);

        var frozen = await store.FreezePreQueueSizeAsync(eid);
        Assert.Equal(2, frozen);
        Assert.Equal(2, await store.FreezePreQueueSizeAsync(eid)); // idempotent

        Assert.Equal(2, await store.EnqueueLateAsync(eid, "L1", frozen)); // first latecomer
        Assert.Equal(3, await store.EnqueueLateAsync(eid, "L2", frozen));
        Assert.Equal(2, await store.EnqueueLateAsync(eid, "L1", frozen)); // stable on repeat
    }
}
```

- [ ] **Step 3: Run to confirm failure**

Run: `dotnet test --filter QueueStoreTests`
Expected: FAIL (QueueStore/EventConfig do not exist).

- [ ] **Step 4: Implement `Queue/EventConfig.cs`**

```csharp
namespace QueueService.Queue;

public sealed record EventConfig(string Eid, DateTimeOffset T0, double Rate, bool Armed, long? PreQueueSize);
```

- [ ] **Step 5: Implement `Queue/QueueStore.cs`**

```csharp
using StackExchange.Redis;

namespace QueueService.Queue;

/// All Redis state for the waiting room. Keys are namespaced per event id.
public sealed class QueueStore(IConnectionMultiplexer mux)
{
    private IDatabase Db => mux.GetDatabase();

    private static string Cfg(string e) => $"q:{e}:cfg";
    private static string PreQueue(string e) => $"q:{e}:prequeue";
    private static string LateCtr(string e) => $"q:{e}:late";
    private static string LatePos(string e) => $"q:{e}:latepos";

    public async Task SetConfigAsync(EventConfig c)
    {
        var entries = new List<HashEntry>
        {
            new("t0", c.T0.ToUnixTimeMilliseconds()),
            new("rate", c.Rate),
            new("armed", c.Armed ? 1 : 0),
        };
        if (c.PreQueueSize is long pq) entries.Add(new HashEntry("pqsize", pq));
        await Db.HashSetAsync(Cfg(c.Eid), entries.ToArray());
    }

    public async Task<EventConfig?> GetConfigAsync(string eid)
    {
        var h = await Db.HashGetAllAsync(Cfg(eid));
        if (h.Length == 0) return null;
        var map = h.ToDictionary(x => (string)x.Name!, x => x.Value);
        long? pq = map.TryGetValue("pqsize", out var pqv) ? (long)pqv : null;
        return new EventConfig(
            eid,
            DateTimeOffset.FromUnixTimeMilliseconds((long)map["t0"]),
            (double)map["rate"],
            (long)map["armed"] == 1,
            pq);
    }

    public Task EnqueuePreQueueAsync(string eid, string mid, double score)
        => Db.SortedSetAddAsync(PreQueue(eid), mid, score, When.NotExists);

    public Task<long?> RankInPreQueueAsync(string eid, string mid)
        => Db.SortedSetRankAsync(PreQueue(eid), mid);

    /// Freezes (once) and returns the pre-queue size. Idempotent via HSETNX.
    public async Task<long> FreezePreQueueSizeAsync(string eid)
    {
        var existing = await Db.HashGetAsync(Cfg(eid), "pqsize");
        if (existing.HasValue) return (long)existing;
        var size = await Db.SortedSetLengthAsync(PreQueue(eid));
        await Db.HashSetAsync(Cfg(eid), "pqsize", size, When.NotExists);
        return (long)(await Db.HashGetAsync(Cfg(eid), "pqsize"));
    }

    /// Stable FIFO position for a latecomer: pqSize + (1-based arrival - 1).
    public async Task<long> EnqueueLateAsync(string eid, string mid, long pqSize)
    {
        var existing = await Db.HashGetAsync(LatePos(eid), mid);
        if (existing.HasValue) return (long)existing;
        var n = await Db.StringIncrementAsync(LateCtr(eid)); // 1-based
        var pos = pqSize + (n - 1);
        await Db.HashSetAsync(LatePos(eid), mid, pos, When.NotExists);
        return (long)(await Db.HashGetAsync(LatePos(eid), mid));
    }
}
```

- [ ] **Step 6: Run to confirm pass**

Run: `dotnet test --filter QueueStoreTests`
Expected: PASS (4 tests). (Requires Docker running for Testcontainers.)

- [ ] **Step 7: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): Redis-backed queue store with random pre-queue and stable late positions"
```

---

## Task 6: QueueCoordinator (orchestration)

**Files:**
- Create: `services/queue-service/src/QueueService/Queue/Results.cs`
- Create: `services/queue-service/src/QueueService/Queue/QueueCoordinator.cs`
- Test: `services/queue-service/tests/QueueService.Tests/QueueCoordinatorTests.cs`

- [ ] **Step 1: Write `Queue/Results.cs`**

```csharp
using QueueService.Tokens;

namespace QueueService.Queue;

public sealed record EnqueueResult(PreQueueTicket Ticket, string Phase, long? Position, EventConfig Config);
public sealed record StatusResult(PreQueueTicket Ticket, long Position, long Serving, bool Admitted, double WaitSeconds);
public sealed record ClaimResult(bool Admitted, string? Token, PreQueueTicket Ticket);
```

- [ ] **Step 2: Write the failing coordinator tests**

Create `tests/QueueService.Tests/QueueCoordinatorTests.cs`:
```csharp
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Tokens;
using Xunit;

[Collection("redis")]
public class QueueCoordinatorTests(RedisFixture fx)
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 16, 10, 0, 0, TimeSpan.Zero);

    private (QueueCoordinator coord, FakeTimeProvider clock, string eid) New()
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var clock = new FakeTimeProvider(T0.AddMinutes(-5)); // start 5 min before sale
        var opts = Options.Create(new QueueOptions
        {
            HmacSecret = new string('k', 32), RedisConnection = "x",
            AdmissionTtlSeconds = 600, SlidingGraceSeconds = 60
        });
        var store = new QueueStore(fx.Mux);
        var tokens = new TokenService(opts.Value.HmacSecret);
        var coord = new QueueCoordinator(store, tokens, clock, opts);
        store.SetConfigAsync(new EventConfig(eid, T0, rate: 100, armed: true, null)).GetAwaiter().GetResult();
        return (coord, clock, eid);
    }

    [Fact]
    public async Task Enqueue_before_T0_is_pre_phase_with_no_frozen_position()
    {
        var (coord, _, eid) = New();
        var r = await coord.EnqueueAsync(eid, existing: null);
        Assert.Equal("pre", r.Phase);
        Assert.Null(r.Ticket.Pos);
        Assert.True(r.Ticket.R is >= 0 and < 1);
    }

    [Fact]
    public async Task Status_after_T0_freezes_position_into_ticket()
    {
        var (coord, clock, eid) = New();
        var enq = await coord.EnqueueAsync(eid, existing: null);   // pre-queue, no pos
        clock.SetUtcNow(T0.AddSeconds(1));                          // sale open
        var st = await coord.GetStatusAsync(eid, enq.Ticket);
        Assert.NotNull(st.Ticket.Pos);                             // frozen now
        Assert.Equal(0, st.Position);                              // sole member -> rank 0
        Assert.True(st.Admitted);                                  // serving(1s)=100 > 0
    }

    [Fact]
    public async Task Not_admitted_until_serving_passes_position()
    {
        var (coord, clock, eid) = New();
        // 150 pre-queuers; our member lands at some rank; force a high rank by enqueuing many.
        var mine = await coord.EnqueueAsync(eid, existing: null);
        for (var i = 0; i < 500; i++)
            await coord.EnqueueAsync(eid, existing: null);

        clock.SetUtcNow(T0.AddMilliseconds(1)); // serving ~ 0
        var early = await coord.GetStatusAsync(eid, mine.Ticket);
        clock.SetUtcNow(T0.AddSeconds(10));      // serving = 1000 > any rank (<=500)
        var later = await coord.GetStatusAsync(eid, early.Ticket);

        Assert.True(later.Admitted);
        Assert.True(later.WaitSeconds == 0);
    }

    [Fact]
    public async Task Claim_returns_signed_token_only_when_admitted()
    {
        var (coord, clock, eid) = New();
        var enq = await coord.EnqueueAsync(eid, existing: null);
        clock.SetUtcNow(T0.AddSeconds(-1));
        var tooEarly = await coord.ClaimAsync(eid, enq.Ticket);
        Assert.False(tooEarly.Admitted);
        Assert.Null(tooEarly.Token);

        clock.SetUtcNow(T0.AddSeconds(1));
        var ok = await coord.ClaimAsync(eid, enq.Ticket);
        Assert.True(ok.Admitted);
        Assert.NotNull(ok.Token);
    }
}
```

- [ ] **Step 3: Run to confirm failure**

Run: `dotnet test --filter QueueCoordinatorTests`
Expected: FAIL (QueueCoordinator does not exist).

- [ ] **Step 4: Implement `Queue/QueueCoordinator.cs`**

```csharp
using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using QueueService.Admission;
using QueueService.Options;
using QueueService.Tokens;

namespace QueueService.Queue;

/// Orchestrates store + tokens + clock. Used by both the API and the Razor page.
public sealed class QueueCoordinator(
    QueueStore store, TokenService tokens, TimeProvider clock, IOptions<QueueOptions> options)
{
    private readonly QueueOptions _opt = options.Value;

    public async Task<EventConfig> RequireConfigAsync(string eid)
        => await store.GetConfigAsync(eid)
           ?? throw new InvalidOperationException($"event '{eid}' not configured");

    public async Task<EnqueueResult> EnqueueAsync(string eid, PreQueueTicket? existing)
    {
        var cfg = await RequireConfigAsync(eid);
        var now = clock.GetUtcNow();
        var mid = existing?.Mid ?? Guid.NewGuid().ToString("N");
        var r = existing?.R ?? RandomNumberGenerator.GetInt32(int.MaxValue) / (double)int.MaxValue;

        if (now < cfg.T0)
        {
            await store.EnqueuePreQueueAsync(eid, mid, r);
            var ticket = new PreQueueTicket(eid, mid, r, null, "pre", now.ToUnixTimeSeconds());
            return new EnqueueResult(ticket, "pre", null, cfg);
        }

        var pqSize = await store.FreezePreQueueSizeAsync(eid);
        var pos = await store.EnqueueLateAsync(eid, mid, pqSize);
        var late = new PreQueueTicket(eid, mid, r, pos, "late", now.ToUnixTimeSeconds());
        return new EnqueueResult(late, "late", pos, cfg);
    }

    public async Task<StatusResult> GetStatusAsync(string eid, PreQueueTicket ticket)
    {
        var cfg = await RequireConfigAsync(eid);
        var now = clock.GetUtcNow();
        var (position, updated) = await ResolvePositionAsync(eid, ticket, cfg, now);
        var serving = AdmissionCalculator.Serving(now, cfg.T0, cfg.Rate);
        return new StatusResult(
            updated, position, serving,
            AdmissionCalculator.IsAdmitted(position, serving),
            AdmissionCalculator.EstimatedWaitSeconds(position, serving, cfg.Rate));
    }

    public async Task<ClaimResult> ClaimAsync(string eid, PreQueueTicket ticket)
    {
        var status = await GetStatusAsync(eid, ticket);
        if (!status.Admitted) return new ClaimResult(false, null, status.Ticket);

        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var token = new AdmissionToken(
            eid, status.Ticket.Mid, now, now + _opt.AdmissionTtlSeconds,
            Guid.NewGuid().ToString("N"));
        return new ClaimResult(true, tokens.Sign(token), status.Ticket);
    }

    public Task<long> ServingAsync(string eid) => ServingValueAsync(eid);

    private async Task<long> ServingValueAsync(string eid)
    {
        var cfg = await RequireConfigAsync(eid);
        return AdmissionCalculator.Serving(clock.GetUtcNow(), cfg.T0, cfg.Rate);
    }

    // Returns the member's position and a (possibly updated, position-frozen) ticket.
    private async Task<(long position, PreQueueTicket ticket)> ResolvePositionAsync(
        string eid, PreQueueTicket ticket, EventConfig cfg, DateTimeOffset now)
    {
        if (ticket.Pos is long fixedPos) return (fixedPos, ticket);

        // Pre-queue member whose position is not yet frozen.
        if (now < cfg.T0)
        {
            var provisional = await store.RankInPreQueueAsync(eid, ticket.Mid) ?? 0;
            return (provisional, ticket); // not frozen; serving=0 before T0 so never admitted
        }

        await store.FreezePreQueueSizeAsync(eid);
        var rank = await store.RankInPreQueueAsync(eid, ticket.Mid) ?? 0;
        var frozen = ticket with { Pos = rank, Phase = "pre" };
        return (rank, frozen);
    }
}
```

- [ ] **Step 5: Run to confirm pass**

Run: `dotnet test --filter QueueCoordinatorTests`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): coordinator orchestrating enqueue/status/claim with injected clock"
```

---

## Task 7: Minimal API endpoints + HTTP integration tests

**Files:**
- Create: `services/queue-service/src/QueueService/Endpoints/QueueEndpoints.cs`
- Modify: `services/queue-service/src/QueueService/Program.cs`
- Modify: `services/queue-service/tests/QueueService.Tests/EndpointsTests.cs`

Cookie name: `qq_ticket` (httpOnly, SameSite=Lax). Endpoints read/write it via `TokenService`.

- [ ] **Step 1: Write the failing endpoint tests**

Append to `tests/QueueService.Tests/EndpointsTests.cs`:
```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using QueueService.Queue;
using StackExchange.Redis;
using Xunit;

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
        var eid = await SeedEvent(f, openSecondsAgo: 10, rate: 100);
        var res = await f.CreateClient().GetAsync($"/api/serving?e={eid}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("max-age", res.Headers.CacheControl!.ToString());
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1000, body.GetProperty("serving").GetInt64()); // 100 * 10s
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

    private static async Task<string> SeedEvent(WebApplicationFactory<Program> f, int openSecondsAgo, double rate)
    {
        var eid = "E-" + Guid.NewGuid().ToString("N");
        var store = new QueueStore(((IConnectionMultiplexer)f.Services.GetService(typeof(IConnectionMultiplexer))!));
        var t0 = DateTimeOffset.UtcNow.AddSeconds(-openSecondsAgo);
        await store.SetConfigAsync(new EventConfig(eid, t0, rate, true, null));
        return eid;
    }
}
```
(Add `using Microsoft.Extensions.DependencyInjection;` and `using Microsoft.Extensions.DependencyInjection.Extensions;` at the top of the file for `RemoveAll`.)

- [ ] **Step 2: Run to confirm failure**

Run: `dotnet test --filter QueueApiTests`
Expected: FAIL (endpoints not mapped).

- [ ] **Step 3: Implement `Endpoints/QueueEndpoints.cs`**

```csharp
using QueueService.Queue;
using QueueService.Tokens;

namespace QueueService.Endpoints;

public static class QueueEndpoints
{
    public const string TicketCookie = "qq_ticket";

    public static IEndpointRouteBuilder MapQueueApi(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/serving", async (string e, QueueCoordinator coord, HttpResponse res) =>
        {
            var serving = await coord.ServingAsync(e);
            res.Headers.CacheControl = "public, max-age=1";
            return Results.Ok(new { serving });
        });

        app.MapPost("/api/enqueue", async (string e, HttpRequest req, HttpResponse res,
            QueueCoordinator coord, TokenService tokens) =>
        {
            var existing = ReadTicket(req, tokens, e);
            var r = await coord.EnqueueAsync(e, existing);
            WriteTicket(res, tokens, r.Ticket);
            return Results.Ok(new { mid = r.Ticket.Mid, phase = r.Phase, position = r.Position });
        });

        app.MapGet("/api/status", async (string e, HttpRequest req, HttpResponse res,
            QueueCoordinator coord, TokenService tokens) =>
        {
            var ticket = ReadTicket(req, tokens, e);
            if (ticket is null) return Results.Unauthorized();
            var st = await coord.GetStatusAsync(e, ticket);
            WriteTicket(res, tokens, st.Ticket); // refresh frozen position
            return Results.Ok(new { position = st.Position, serving = st.Serving,
                admitted = st.Admitted, waitSeconds = st.WaitSeconds });
        });

        app.MapPost("/api/claim", async (string e, HttpRequest req, HttpResponse res,
            QueueCoordinator coord, TokenService tokens) =>
        {
            var ticket = ReadTicket(req, tokens, e);
            if (ticket is null) return Results.Unauthorized();
            var claim = await coord.ClaimAsync(e, ticket);
            WriteTicket(res, tokens, claim.Ticket);
            return claim.Admitted
                ? Results.Ok(new { token = claim.Token })
                : Results.StatusCode(StatusCodes.Status425TooEarly);
        });

        return app;
    }

    private static PreQueueTicket? ReadTicket(HttpRequest req, TokenService tokens, string eid)
    {
        if (!req.Cookies.TryGetValue(TicketCookie, out var raw)) return null;
        return tokens.TryVerify<PreQueueTicket>(raw!, out var t) && t!.Eid == eid ? t : null;
    }

    private static void WriteTicket(HttpResponse res, TokenService tokens, PreQueueTicket ticket)
        => res.Cookies.Append(TicketCookie, tokens.Sign(ticket), new CookieOptions
        {
            HttpOnly = true, IsEssential = true,
            SameSite = SameSiteMode.Lax, Secure = false // Secure=true behind TLS in real deploys
        });
}
```

- [ ] **Step 4: Wire services + endpoints in `Program.cs`**

Final `Program.cs`:
```csharp
using QueueService.Endpoints;
using QueueService.Options;
using QueueService.Queue;
using QueueService.Tokens;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<QueueOptions>()
    .Bind(builder.Configuration.GetSection(QueueOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var opt = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<QueueOptions>>().Value;
    return ConnectionMultiplexer.Connect(opt.RedisConnection);
});
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<QueueStore>();
builder.Services.AddSingleton<TokenService>(sp =>
    new TokenService(sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<QueueOptions>>().Value.HmacSecret));
builder.Services.AddSingleton<QueueCoordinator>();
builder.Services.AddRazorPages();
builder.Services.AddHealthChecks();

var app = builder.Build();
app.UseStaticFiles();
app.MapHealthChecks("/healthz");
app.MapQueueApi();
app.MapRazorPages();
app.Run();

public partial class Program;
```

- [ ] **Step 5: Run to confirm pass**

Run: `dotnet test --filter QueueApiTests`
Expected: PASS (3 tests). Run the full suite too: `dotnet test` → all green.

- [ ] **Step 6: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): minimal API for serving/enqueue/status/claim with signed ticket cookie"
```

---

## Task 8: Server-rendered waiting page + vanilla poller

**Files:**
- Create: `services/queue-service/src/QueueService/Pages/Wait.cshtml`
- Create: `services/queue-service/src/QueueService/Pages/Wait.cshtml.cs`
- Create: `services/queue-service/src/QueueService/wwwroot/js/wait.js`
- Modify: `services/queue-service/tests/QueueService.Tests/EndpointsTests.cs`

- [ ] **Step 1: Write a failing page-render test**

Append to `EndpointsTests.cs` (inside the `QueueApiTests` class):
```csharp
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `dotnet test --filter Wait_page_renders`
Expected: FAIL (no `/wait` page).

- [ ] **Step 3: Implement `Pages/Wait.cshtml.cs`**

```csharp
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using QueueService.Endpoints;
using QueueService.Queue;
using QueueService.Tokens;

namespace QueueService.Pages;

public class WaitModel(QueueCoordinator coord, TokenService tokens) : PageModel
{
    [BindProperty(SupportsGet = true, Name = "e")] public string Eid { get; set; } = "";
    [BindProperty(SupportsGet = true, Name = "target")] public string Target { get; set; } = "/";
    public long T0Unix { get; private set; }
    public double Rate { get; private set; }

    public async Task<IActionResult> OnGetAsync()
    {
        var cfg = await coord.GetConfigOrNullAsync(Eid);
        if (cfg is null) return NotFound();

        var existing = Request.Cookies.TryGetValue(QueueEndpoints.TicketCookie, out var raw)
            && tokens.TryVerify<PreQueueTicket>(raw!, out var t) && t!.Eid == Eid ? t : null;

        var enq = await coord.EnqueueAsync(Eid, existing);
        Response.Cookies.Append(QueueEndpoints.TicketCookie, tokens.Sign(enq.Ticket),
            new CookieOptions { HttpOnly = true, IsEssential = true, SameSite = SameSiteMode.Lax });

        T0Unix = cfg.T0.ToUnixTimeMilliseconds();
        Rate = cfg.Rate;
        return Page();
    }
}
```

- [ ] **Step 4: Add `GetConfigOrNullAsync` to `QueueCoordinator`**

In `Queue/QueueCoordinator.cs`, add:
```csharp
    public Task<EventConfig?> GetConfigOrNullAsync(string eid) => store.GetConfigAsync(eid);
```

- [ ] **Step 5: Implement `Pages/Wait.cshtml`**

```html
@page
@model QueueService.Pages.WaitModel
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>You're in line</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 12vh auto; text-align: center; }
    #wait, #pos { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body
  data-eid="@Model.Eid"
  data-target="@Model.Target"
  data-t0="@Model.T0Unix"
  data-rate="@Model.Rate">
  <h1>You're in line</h1>
  <p>Hold tight — you'll be let in automatically. You can close this tab and come back.</p>
  <p>Sale starts in <span id="countdown">—</span></p>
  <p>Position: <span id="pos">—</span> · Est. wait: <span id="wait">—</span></p>
  <script src="/js/wait.js" defer></script>
</body>
</html>
```

- [ ] **Step 6: Implement `wwwroot/js/wait.js`**

```javascript
// Minimal poller: counts down to T0, then polls cached /serving and the user's
// /status, and redirects to the main site (with the admission token) once admitted.
const b = document.body.dataset;
const eid = b.eid, target = b.target, t0 = Number(b.t0), rate = Number(b.rate);
const $ = (id) => document.getElementById(id);

function fmt(s) { s = Math.max(0, Math.round(s)); const m = (s / 60) | 0; return m ? `${m}m ${s % 60}s` : `${s}s`; }

async function tick() {
  const now = Date.now();
  if (now < t0) { $("countdown").textContent = fmt((t0 - now) / 1000); return; }
  $("countdown").textContent = "open";

  const st = await fetch(`/api/status?e=${encodeURIComponent(eid)}`).then(r => r.json());
  $("pos").textContent = st.position;
  $("wait").textContent = fmt(st.waitSeconds);

  if (st.admitted) {
    const { token } = await fetch(`/api/claim?e=${encodeURIComponent(eid)}`, { method: "POST" }).then(r => r.json());
    if (token) {
      const sep = target.includes("?") ? "&" : "?";
      window.location = `${target}${sep}qpass=${encodeURIComponent(token)}`;
    }
  }
}
setInterval(tick, 2000);
tick();
```

- [ ] **Step 7: Run to confirm pass**

Run: `dotnet test --filter Wait_page_renders`
Expected: PASS. Full suite: `dotnet test` → all green.

- [ ] **Step 8: Commit**

```bash
git add services/queue-service
git commit -m "feat(queue): server-rendered waiting page with minimal vanilla poller"
```

---

## Task 9: Dockerfile (chiseled) + isolated local compose group

**Files:**
- Create: `services/queue-service/src/QueueService/Dockerfile`
- Create: `docker-compose.queue.yml` (repo root)

- [ ] **Step 1: Write `services/queue-service/src/QueueService/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY QueueService.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled AS final
WORKDIR /app
COPY --from=build /app .
# chiseled images already run as the non-root `app` user; expose the Kestrel port
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "QueueService.dll"]
```

- [ ] **Step 2: Write `docker-compose.queue.yml` (isolated group + own Redis)**

```yaml
# Isolated waiting-room group. Run separately from the main stack:
#   docker compose -f docker-compose.queue.yml up --build
name: queue
services:
  queue-redis:
    image: redis:7-alpine
    ports: ["6390:6379"]      # distinct host port — no clash with the main stack
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
  queue-service:
    build:
      context: ./services/queue-service/src/QueueService
    ports: ["4100:8080"]      # waiting page + API on a distinct host port
    environment:
      Queue__HmacSecret: "dev-secret-change-me-32-chars-minimum"
      Queue__RedisConnection: "queue-redis:6379"
    depends_on:
      queue-redis:
        condition: service_healthy
```

- [ ] **Step 3: Build and smoke-test the group**

Run:
```bash
docker compose -f docker-compose.queue.yml up --build -d
curl -fsS http://localhost:4100/healthz && echo OK
docker compose -f docker-compose.queue.yml down
```
Expected: image builds on the chiseled runtime; `/healthz` returns 200 (`OK` printed).

- [ ] **Step 4: Manual end-to-end smoke (optional but recommended)**

Run (with the group up):
```bash
# seed an event that opened 5s ago, rate 100/s, via redis-cli
docker compose -f docker-compose.queue.yml exec -T queue-redis redis-cli \
  HSET q:E1:cfg t0 $(( ($(date +%s) - 5) * 1000 )) rate 100 armed 1
curl -fsS "http://localhost:4100/api/serving?e=E1"            # -> {"serving":~500}
curl -fsS -c jar.txt -X POST "http://localhost:4100/api/enqueue?e=E1"
curl -fsS -b jar.txt -X POST "http://localhost:4100/api/claim?e=E1"   # -> {"token":"..."}
```
Expected: `serving` > 0, enqueue sets a cookie, claim returns a token.

- [ ] **Step 5: Commit**

```bash
git add services/queue-service/src/QueueService/Dockerfile docker-compose.queue.yml
git commit -m "feat(queue): chiseled non-root image and isolated local compose group"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Separate domain/resources (#1) → Task 9 isolated compose group + own Redis (own ports). ✓
- Redirect navigation (#2) → `wait.js` redirects to `target?qpass=` (Task 8); the inbound 302 is Plan 2 (connector). ✓ (queue side covered)
- Cache the code / no open tab (#3) → durable `qq_ticket` cookie + frozen position (Tasks 6–7). ✓
- Buffer after access (#4) → `AdmissionTtlSeconds`/`SlidingGraceSeconds` options exist (Task 2); the access **cookie** that consumes them is set by the connector in Plan 2. ✓ (config carrier present; consumer is Plan 2 — noted, not a gap)
- Extreme traffic by calculation (#5) → pure `serving(t)` + cacheable `/api/serving` (Tasks 3, 7). ✓
- Pre-queue randomized draw → FIFO → random-scored ZSET + frozen rank + late counter (Tasks 5–6). ✓
- ASP.NET Core 10 / Razor + Minimal API / StackExchange.Redis only / chiseled non-root → Tasks 1, 7, 8, 9. ✓

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `PreQueueTicket`/`AdmissionToken`/`EventConfig`/`EnqueueResult`/`StatusResult`/`ClaimResult` field names and `AdmissionCalculator`/`QueueStore`/`QueueCoordinator` method signatures are identical across Tasks 3–8. `TicketCookie = "qq_ticket"` referenced consistently in endpoints and the Razor page.

**Note for executor:** Tasks 5–7 and the coordinator/API tests require Docker running (Testcontainers). Run `dotnet test` with Docker Desktop up.
