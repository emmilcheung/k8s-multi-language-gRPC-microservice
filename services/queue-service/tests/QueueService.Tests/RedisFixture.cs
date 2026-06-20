using StackExchange.Redis;
using Testcontainers.Redis;
using Xunit;

/// Provides a Redis connection for integration tests.
/// - If REDIS_TEST_CONNECTION is set, connect to that (externally-managed Redis).
/// - Otherwise spin up a hermetic Testcontainers Redis (default for CI).
public sealed class RedisFixture : IAsyncLifetime
{
    private readonly RedisContainer? _container;
    private readonly string? _externalConn;
    public IConnectionMultiplexer Mux { get; private set; } = default!;

    public RedisFixture()
    {
        _externalConn = Environment.GetEnvironmentVariable("REDIS_TEST_CONNECTION");
        if (string.IsNullOrEmpty(_externalConn))
            _container = new RedisBuilder("redis:7-alpine").Build();
    }

    public async Task InitializeAsync()
    {
        string conn;
        if (_container is not null)
        {
            await _container.StartAsync();
            conn = _container.GetConnectionString();
        }
        else
        {
            conn = _externalConn!;
        }
        Mux = await ConnectionMultiplexer.ConnectAsync(conn);
    }

    public async Task DisposeAsync()
    {
        if (Mux is not null) await Mux.DisposeAsync();
        if (_container is not null) await _container.DisposeAsync();
    }
}

[CollectionDefinition("redis")]
public sealed class RedisCollection : ICollectionFixture<RedisFixture>;
