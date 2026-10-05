using StackExchange.Redis;

namespace QueueService.Queue;

/// All Redis state for the waiting room. Keys are namespaced per event id and
/// carry a TTL so abandoned events self-clean (no unbounded growth).
public class QueueStore(IConnectionMultiplexer mux)
{
    private IDatabase Db => mux.GetDatabase();

    // The event id sits inside a literal hash tag (`{{` is a literal brace
    // in an interpolated string), so every key for one event hashes to the same
    // Redis Cluster slot. FreezeLua and EnqueueLateLua each take two of these keys
    // in one script, which a cluster refuses with CROSSSLOT unless they share a slot.
    private static string Cfg(string e) => $"q:{{{e}}}:cfg";
    private static string PreQueue(string e) => $"q:{{{e}}}:prequeue";
    private static string LateCtr(string e) => $"q:{{{e}}}:late";
    private static string LatePos(string e) => $"q:{{{e}}}:latepos";
    private static string Owner(string e, string mid) => $"q:{{{e}}}:owner:{mid}";
    private static string Pass(string e, string sub) => $"q:{{{e}}}:pass:{sub}";

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
            new("servingBase", c.ServingBase),
            new("soldout", c.SoldOut ? 1 : 0),
            new("paused", c.Paused ? 1 : 0),
            new("venuePaused", c.VenuePaused ? 1 : 0),
        };
        if (c.TBase is { } tb) entries.Add(new HashEntry("tBase", tb.ToUnixTimeMilliseconds()));
        if (c.PreQueueSize is long pq) entries.Add(new HashEntry("pqsize", pq));
        await Db.HashSetAsync(Cfg(c.Eid), entries.ToArray());
    }

    public virtual async Task<EventConfig?> GetConfigAsync(string eid)
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
            pq,
            map.TryGetValue("servingBase", out var sb) ? (long)sb : 0,
            map.TryGetValue("tBase", out var tb) ? DateTimeOffset.FromUnixTimeMilliseconds((long)tb) : null,
            map.TryGetValue("soldout", out var so) && (long)so == 1,
            map.TryGetValue("paused", out var pa) && (long)pa == 1,
            map.TryGetValue("venuePaused", out var vpa) && (long)vpa == 1);
    }

    // Shared by the scripts below: serving as EventConfig.ServingAt computes it.
    // Expects `now` (ms) and the cfg fields as locals: t0, rate, base, tb, paused, vp.
    private const string ServingLua = @"
local function serving()
  if paused or vp then return base end
  if now <= t0 then return 0 end
  return base + math.floor(rate * math.max(0, (now - tb) / 1000))
end
local rebase = math.max(now, t0)";

    // Read, compute and write in one script, so two operators changing the same
    // event cannot overwrite each other's rebase. KEYS[1]=cfg hash.
    // ARGV: op (rate|paused|soldout), value, now in ms. Returns 0 if the event has no config.
    private const string AdminUpdateLua = @"
local c = redis.call('HMGET', KEYS[1], 't0', 'rate', 'servingBase', 'tBase', 'paused', 'venuePaused')
if not c[1] then return 0 end
local t0, rate = tonumber(c[1]), tonumber(c[2])
local base = tonumber(c[3]) or 0
local tb = tonumber(c[4]) or t0
local paused, vp = c[5] == '1', c[6] == '1'
local now = tonumber(ARGV[3])
" + ServingLua + @"
local op, v = ARGV[1], ARGV[2]
if op == 'rate' then
  redis.call('HSET', KEYS[1], 'servingBase', string.format('%.0f', serving()), 'tBase', string.format('%.0f', rebase), 'rate', v)
elseif op == 'paused' then
  local want = v == '1'
  if want == paused then return 1 end
  if want then
    redis.call('HSET', KEYS[1], 'servingBase', string.format('%.0f', serving()), 'paused', 1)
  else
    redis.call('HSET', KEYS[1], 'tBase', string.format('%.0f', rebase), 'paused', 0)
  end
else
  redis.call('HSET', KEYS[1], 'soldout', v)
end
return 1";

    // Idempotent venue freeze/unfreeze: only the first pod to see a change writes the
    // flag, the rest find it already set. While it is set, a pod with a fresh reading
    // also stamps venueAt (only ever forward), which is how other pods know the pause
    // is still being reported. KEYS[1]=cfg hash.
    // ARGV: want (1 frozen, 0 running), now in ms, the reading's time in ms.
    private const string VenuePauseLua = @"
local c = redis.call('HMGET', KEYS[1], 't0', 'rate', 'servingBase', 'tBase', 'paused', 'venuePaused', 'venueAt')
if not c[1] then return 0 end
local t0, rate = tonumber(c[1]), tonumber(c[2])
local base = tonumber(c[3]) or 0
local tb = tonumber(c[4]) or t0
local paused, vp = c[5] == '1', c[6] == '1'
local now = tonumber(ARGV[2])
" + ServingLua + @"
local want = ARGV[1] == '1'
local at = tonumber(ARGV[3])
if want == vp then
  if want and at > (tonumber(c[7]) or 0) then redis.call('HSET', KEYS[1], 'venueAt', string.format('%.0f', at)) end
  return 0
end
if want then
  if not paused then redis.call('HSET', KEYS[1], 'servingBase', string.format('%.0f', serving())) end
  redis.call('HSET', KEYS[1], 'venuePaused', 1, 'venueAt', string.format('%.0f', at))
else
  if not paused then redis.call('HSET', KEYS[1], 'tBase', string.format('%.0f', rebase)) end
  redis.call('HSET', KEYS[1], 'venuePaused', 0)
end
return 1";

    // Clears a venue flag nobody is refreshing any more. Both conditions are checked in
    // here, so it cannot fight a pod that has just stamped a fresh reading. Serving
    // resumes as of the lapse moment (venueAt + lapse), never earlier than the base
    // time already set, so it neither jumps ahead nor rewinds. A flag with no venueAt
    // (set by an older pod) gets one now and lapses a full lapse from here.
    // KEYS[1]=cfg hash. ARGV: now in ms, lapse in ms. Returns 1 only for the call that cleared it.
    private const string VenueLapseLua = @"
local c = redis.call('HMGET', KEYS[1], 't0', 'tBase', 'paused', 'venuePaused', 'venueAt')
if not c[1] or c[4] ~= '1' then return 0 end
local now, lapse = tonumber(ARGV[1]), tonumber(ARGV[2])
local at = tonumber(c[5])
if not at then
  redis.call('HSET', KEYS[1], 'venueAt', string.format('%.0f', now))
  return 0
end
if now - at <= lapse then return 0 end
if c[3] ~= '1' then
  local resume = math.max(at + lapse, tonumber(c[1]), tonumber(c[2]) or 0)
  redis.call('HSET', KEYS[1], 'tBase', string.format('%.0f', resume))
end
redis.call('HSET', KEYS[1], 'venuePaused', 0)
return 1";

    /// Applies one operator change atomically. Returns false if the event has no config.
    public async Task<bool> AdminUpdateAsync(string eid, string op, RedisValue value, DateTimeOffset now)
        => (long)await Db.ScriptEvaluateAsync(AdminUpdateLua, new RedisKey[] { Cfg(eid) },
            new RedisValue[] { op, value, now.ToUnixTimeMilliseconds() }) == 1;

    /// Freezes (or releases) serving for the venue's paused / sold-out signal. Safe to call
    /// from every pod: returns true only for the call that changed the flag. While the flag
    /// is set, calling it with the venue's reading time (<paramref name="readingAt"/>, default
    /// now) records that the pause is still being reported.
    public async Task<bool> SetVenuePausedAsync(string eid, bool paused, DateTimeOffset now, DateTimeOffset? readingAt = null)
        => (long)await Db.ScriptEvaluateAsync(VenuePauseLua, new RedisKey[] { Cfg(eid) },
            new RedisValue[] { paused ? 1 : 0, now.ToUnixTimeMilliseconds(), (readingAt ?? now).ToUnixTimeMilliseconds() }) == 1;

    /// Clears a venue flag that no pod has refreshed for <paramref name="lapse"/>. For a pod
    /// without a fresh venue reading; returns true only for the call that cleared it.
    public async Task<bool> LapseVenuePauseAsync(string eid, DateTimeOffset now, TimeSpan lapse)
        => (long)await Db.ScriptEvaluateAsync(VenueLapseLua, new RedisKey[] { Cfg(eid) },
            new RedisValue[] { now.ToUnixTimeMilliseconds(), (long)lapse.TotalMilliseconds }) == 1;

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

    /// Binds a queue place to the first account that redeems it and returns
    /// that account (the caller's own sub when it won).
    public async Task<string> BindOwnerAsync(string eid, string mid, string sub, int ttlSeconds)
    {
        if (await Db.StringSetAsync(Owner(eid, mid), sub, TimeSpan.FromSeconds(ttlSeconds), When.NotExists))
            return sub;
        return (string?)await Db.StringGetAsync(Owner(eid, mid)) ?? sub;
    }

    public async Task<string?> GetPassAsync(string eid, string sub)
        => await Db.StringGetAsync(Pass(eid, sub));

    /// Stores the account's pass unless one is already there; returns the stored one.
    public async Task<string> SetPassOnceAsync(string eid, string sub, string pass, int ttlSeconds)
    {
        if (await Db.StringSetAsync(Pass(eid, sub), pass, TimeSpan.FromSeconds(ttlSeconds), When.NotExists))
            return pass;
        return await GetPassAsync(eid, sub) ?? pass;
    }
}
