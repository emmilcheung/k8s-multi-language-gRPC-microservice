using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.Options;
using QueueService.Options;

namespace QueueService.Queue;

/// What this pod currently believes about one event: its config and the flags that
/// stop claims (the operator's, OR'd with the venue's). Serving is computed from it
/// and the clock, so no call needs Redis. Both an operator pause and a venue pause
/// freeze serving (the venue's through a flag in the config, set once by whichever
/// pod sees it first), so a seat hold lapsing cannot let everyone below serving
/// claim at once.
public sealed record EventSnapshot(EventConfig Config, bool SoldOut, bool Paused)
{
    public long Serving(DateTimeOffset now) => Config.ServingAt(now);
}

/// Per-pod, per-event snapshot refreshed at most once a second. Concurrent misses
/// share one Redis read, so the config read rate is bounded by pods x events, not
/// by how many visitors poll.
///
/// When Queue:VenueAvailabilityUrl is set, a refresh also starts a background poll of
/// the venue (at most every 2 s per event). It never waits on it: the answer lands in
/// the next snapshot, and a failing venue only means "no automatic signal".
///
/// A snapshot younger than StaleWindow is returned at once even when due for a refresh;
/// the refresh runs in the background (one at a time, backing off after a failure). So a
/// Redis blip neither slows nor fails waiting visitors' polls; past StaleWindow callers
/// wait on the load and see its error.
public sealed class EventSnapshotCache(
    QueueStore store, TimeProvider clock, IOptions<QueueOptions> options,
    IHttpClientFactory http, ILogger<EventSnapshotCache> log)
{
    public const string VenueClient = "venue";
    public static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan VenuePollInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan VenueTimeout = TimeSpan.FromMilliseconds(500);
    // After the venue stops answering, its last word is believed this long.
    private static readonly TimeSpan VenueSignalMaxAge = TimeSpan.FromSeconds(10);
    // A venue flag that no pod has refreshed for this long is cleared by whichever pod
    // notices: well past the signal's life plus a poll, so a slow venue never trips it.
    public static readonly TimeSpan VenueFlagLapse = TimeSpan.FromSeconds(30);
    // How long the last good snapshot may stand in for a failing Redis read.
    public static readonly TimeSpan StaleWindow = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan RetryBackoff = TimeSpan.FromSeconds(1);
    private readonly string? _venueUrl = options.Value.VenueAvailabilityUrl;
    private const int PruneAbove = 1024;
    private static readonly TimeSpan PruneAge = TimeSpan.FromMinutes(1);

    private sealed record Slot(EventSnapshot? Value, DateTimeOffset At);

    private sealed class Entry
    {
        public readonly object Gate = new();
        public volatile Slot? Current;
        public TaskCompletionSource<EventSnapshot?>? InFlight;
        public DateTimeOffset RetryAt = DateTimeOffset.MinValue; // after a failed refresh, no new attempt before this
        // Guarded by Gate except Venue, which is replaced whole.
        public volatile VenueSignal? Venue;
        public DateTimeOffset VenuePolledAt = DateTimeOffset.MinValue;
        public DateTimeOffset VenueStamped = DateTimeOffset.MinValue; // last reading time written to Redis (LoadAsync only)
        public bool VenuePolling, VenueFailing;
    }

    private sealed record VenueSignal(bool Paused, bool SoldOut, DateTimeOffset At);
    private sealed record VenueAvailability(int Available, int Held);

    private readonly ConcurrentDictionary<string, Entry> _entries = new();

    /// Null when the event has no config.
    public Task<EventSnapshot?> GetAsync(string eid) => GetAsync(eid, fresh: false);

    /// For decisions that must not rest on a snapshot older than RefreshInterval (a claim):
    /// waits for a load instead of answering from a stale snapshot, and sees its error.
    public Task<EventSnapshot?> GetFreshAsync(string eid) => GetAsync(eid, fresh: true);

    private async Task<EventSnapshot?> GetAsync(string eid, bool fresh)
    {
        var entry = EntryFor(eid);
        TaskCompletionSource<EventSnapshot?> flight;
        var owner = false;
        EventSnapshot? stale = null;
        var serveStale = false;
        lock (entry.Gate)
        {
            var now = clock.GetUtcNow();
            var c = entry.Current;
            if (c is not null && now - c.At < RefreshInterval) return c.Value;
            // A usable snapshot answers at once while the refresh runs behind it, so a slow
            // or dead Redis costs callers nothing until the snapshot is too old to trust.
            if (!fresh && c is { Value: { } last } && now - c.At <= StaleWindow)
            {
                serveStale = true;
                stale = last;
            }
            if (entry.InFlight is null && (!serveStale || now >= entry.RetryAt))
            {
                entry.InFlight = new(TaskCreationOptions.RunContinuationsAsynchronously);
                owner = true;
            }
            flight = entry.InFlight!;
        }

        if (owner) _ = RefreshAsync(eid, entry, flight);
        if (serveStale) return stale;
        return await flight.Task;
    }

    private async Task RefreshAsync(string eid, Entry entry, TaskCompletionSource<EventSnapshot?> flight)
    {
        try
        {
            var snap = await LoadAsync(eid, entry);
            lock (entry.Gate) { entry.InFlight = null; entry.RetryAt = DateTimeOffset.MinValue; }
            flight.SetResult(snap);
        }
        catch (Exception ex)
        {
            lock (entry.Gate) { entry.InFlight = null; entry.RetryAt = clock.GetUtcNow() + RetryBackoff; }
            log.LogWarning(ex, "Redis read for event {Eid} failed; serving the last snapshot while it is under {StaleSeconds} s old",
                eid, (int)StaleWindow.TotalSeconds);
            flight.SetException(ex); // callers with no usable snapshot see it; others never look
            _ = flight.Task.Exception;
        }
    }

    private async Task<EventSnapshot?> LoadAsync(string eid, Entry entry)
    {
        var cfg = await store.GetConfigAsync(eid);
        var now = clock.GetUtcNow();
        EventSnapshot? snap = null;
        if (cfg is not null)
        {
            StartVenuePollIfDue(eid, entry, now);
            var v = entry.Venue is { } sig && now - sig.At <= VenueSignalMaxAge ? sig : null;
            if (v is not null)
            {
                // Freeze serving while the venue says paused or sold out, release it when it
                // stops. Every pod with a fresh reading gets here, but the script flips the
                // flag only once.
                // While it stays set, each new reading is stamped once, so other pods can tell
                // a pause the venue still reports from one nobody is watching.
                var venueHolds = v.Paused || v.SoldOut;
                var flip = venueHolds != cfg.VenuePaused;
                if (flip || (venueHolds && v.At > entry.VenueStamped))
                {
                    await store.SetVenuePausedAsync(eid, venueHolds, now, v.At);
                    entry.VenueStamped = v.At;
                }
                if (flip) cfg = await store.GetConfigAsync(eid) ?? cfg; // also picks up a flip by another pod
                snap = new EventSnapshot(cfg, cfg.SoldOut || v.SoldOut, cfg.Paused || v.Paused);
            }
            else
            {
                // No fresh reading (a new pod, or a venue that stopped answering) means no
                // opinion: leave the shared flag alone and follow it. A pod that merely
                // lacks data must not unfreeze a pause the others set. Only when no pod has
                // stamped a reading for the whole lapse is the flag cleared (atomically, so
                // it cannot fight a pod that just stamped one).
                if (cfg.VenuePaused && await store.LapseVenuePauseAsync(eid, now, VenueFlagLapse))
                    cfg = await store.GetConfigAsync(eid) ?? cfg;
                snap = new EventSnapshot(cfg, cfg.SoldOut, cfg.Paused || cfg.VenuePaused);
            }
        }
        entry.Current = new Slot(snap, now);
        return snap;
    }

    private void StartVenuePollIfDue(string eid, Entry entry, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(_venueUrl)) return;
        lock (entry.Gate)
        {
            if (entry.VenuePolling || now - entry.VenuePolledAt < VenuePollInterval) return;
            entry.VenuePolling = true;
            entry.VenuePolledAt = now;
        }
        _ = PollVenueAsync(eid, entry);
    }

    private async Task PollVenueAsync(string eid, Entry entry)
    {
        try
        {
            using var cts = new CancellationTokenSource(VenueTimeout, clock);
            var url = _venueUrl!.Replace("{eid}", Uri.EscapeDataString(eid));
            using var res = await http.CreateClient(VenueClient).GetAsync(url, cts.Token);
            if (res.StatusCode == HttpStatusCode.NotFound)
            {
                // No seating plan (a general-admission sale): a fresh "nothing to hold", which clears the flag.
                entry.Venue = new VenueSignal(false, false, clock.GetUtcNow());
                Recovered(entry);
                return;
            }
            res.EnsureSuccessStatusCode();
            var a = await res.Content.ReadFromJsonAsync<VenueAvailability>(cts.Token)
                    ?? throw new InvalidDataException("empty venue availability body");
            var none = a.Available > 0;
            entry.Venue = new VenueSignal(!none && a.Held > 0, !none && a.Held == 0, clock.GetUtcNow());
            Recovered(entry);
        }
        catch (Exception ex)
        {
            // Keep the last signal; it ages out on its own. Warn once per outage, not per poll.
            bool first;
            lock (entry.Gate) { first = !entry.VenueFailing; entry.VenueFailing = true; }
            if (first)
                log.LogWarning(ex, "Venue availability for event {Eid} is unavailable; no automatic paused/sold-out signal", eid);
        }
        finally { lock (entry.Gate) entry.VenuePolling = false; }
    }

    private void Recovered(Entry entry)
    {
        bool was;
        lock (entry.Gate) { was = entry.VenueFailing; entry.VenueFailing = false; }
        if (was) log.LogInformation("Venue availability is answering again");
    }

    private Entry EntryFor(string eid)
    {
        if (_entries.TryGetValue(eid, out var e)) return e;
        // Event ids come from the URL, so unknown ones are cached too; drop stale ones
        // before the table can grow without bound.
        if (_entries.Count > PruneAbove)
        {
            var now = clock.GetUtcNow();
            foreach (var (key, v) in _entries)
                if (v.Current is { } c && now - c.At > PruneAge) _entries.TryRemove(key, out _);
        }
        return _entries.GetOrAdd(eid, _ => new Entry());
    }
}
