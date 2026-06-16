using StackExchange.Redis;

namespace QueueService.Queue;

/// All Redis state for the waiting room. Keys are namespaced per event id and
/// carry a TTL so abandoned events self-clean (no unbounded growth).
public sealed class QueueStore(IConnectionMultiplexer mux)
{
    private IDatabase Db => mux.GetDatabase();

    private static string Cfg(string e) => $"q:{e}:cfg";
    private static string PreQueue(string e) => $"q:{e}:prequeue";
    private static string LateCtr(string e) => $"q:{e}:late";
    private static string LatePos(string e) => $"q:{e}:latepos";

    // Atomic: add to the pre-queue under a hard size cap (NX), then (re)set the
    // key TTL. Returns false iff the cap is reached and the member is not present.
    private const string EnqueuePreLua = @"
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], 'NX', ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1";

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

    /// Returns true if the member is in the pre-queue afterwards; false if rejected
    /// because the cap was already reached.
    public async Task<bool> EnqueuePreQueueAsync(string eid, string mid, double score, int maxSize, int ttlSeconds)
    {
        var res = await Db.ScriptEvaluateAsync(EnqueuePreLua,
            new RedisKey[] { PreQueue(eid) },
            new RedisValue[] { score, mid, maxSize, (long)ttlSeconds * 1000 });
        return (long)res == 1;
    }

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
    public async Task<long> EnqueueLateAsync(string eid, string mid, long pqSize, int ttlSeconds)
    {
        var existing = await Db.HashGetAsync(LatePos(eid), mid);
        if (!existing.HasValue)
        {
            var n = await Db.StringIncrementAsync(LateCtr(eid)); // 1-based
            await Db.HashSetAsync(LatePos(eid), mid, pqSize + (n - 1), When.NotExists);
        }
        var ttl = TimeSpan.FromSeconds(ttlSeconds);
        await Db.KeyExpireAsync(LatePos(eid), ttl);
        await Db.KeyExpireAsync(LateCtr(eid), ttl);
        return (long)(await Db.HashGetAsync(LatePos(eid), mid));
    }

    public Task RefreshConfigTtlAsync(string eid, int ttlSeconds)
        => Db.KeyExpireAsync(Cfg(eid), TimeSpan.FromSeconds(ttlSeconds));
}
