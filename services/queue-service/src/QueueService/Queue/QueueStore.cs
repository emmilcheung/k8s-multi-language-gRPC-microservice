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
