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

    // Atomic freeze: set pqsize once (to ZCARD) and return it. No check-then-set race.
    // KEYS[1]=cfg hash, KEYS[2]=prequeue zset.
    private const string FreezeLua = @"
local existing = redis.call('HGET', KEYS[1], 'pqsize')
if existing then return tonumber(existing) end
local size = redis.call('ZCARD', KEYS[2])
redis.call('HSET', KEYS[1], 'pqsize', size)
return size";

    // Atomic late-position assignment: one INCR per distinct mid, ever. Concurrent
    // calls for the same mid return the same position and burn no sequence numbers.
    // KEYS[1]=latepos hash, KEYS[2]=late counter. ARGV: mid, pqSize, ttlMs.
    private const string EnqueueLateLua = @"
local pos = redis.call('HGET', KEYS[1], ARGV[1])
if not pos then
  local n = redis.call('INCR', KEYS[2])
  pos = tonumber(ARGV[2]) + (n - 1)
  redis.call('HSET', KEYS[1], ARGV[1], pos)
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return tonumber(pos)";

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

    /// Freezes (once, atomically) and returns the pre-queue size.
    public async Task<long> FreezePreQueueSizeAsync(string eid)
    {
        var res = await Db.ScriptEvaluateAsync(FreezeLua,
            new RedisKey[] { Cfg(eid), PreQueue(eid) });
        return (long)res;
    }

    /// Stable FIFO position for a latecomer: pqSize + (1-based arrival - 1).
    /// Atomic — concurrent calls for one mid never burn sequence numbers.
    public async Task<long> EnqueueLateAsync(string eid, string mid, long pqSize, int ttlSeconds)
    {
        var res = await Db.ScriptEvaluateAsync(EnqueueLateLua,
            new RedisKey[] { LatePos(eid), LateCtr(eid) },
            new RedisValue[] { mid, pqSize, (long)ttlSeconds * 1000 });
        return (long)res;
    }

    public Task RefreshConfigTtlAsync(string eid, int ttlSeconds)
        => Db.KeyExpireAsync(Cfg(eid), TimeSpan.FromSeconds(ttlSeconds));

    /// Consumes an admission-token nonce exactly once (SETNX with TTL).
    /// Returns true on first use, false if the nonce was already consumed.
    public Task<bool> TryConsumeNonceAsync(string nonce, int ttlSeconds)
        => Db.StringSetAsync($"q:nonce:{nonce}", "1",
            TimeSpan.FromSeconds(Math.Max(1, ttlSeconds)), When.NotExists);
}
