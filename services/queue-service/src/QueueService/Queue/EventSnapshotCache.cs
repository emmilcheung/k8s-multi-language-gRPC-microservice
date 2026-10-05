using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.Options;
using QueueService.Options;

namespace QueueService.Queue;

/// What this pod currently believes about one event: its config and the flags that
/// stop claims (the operator's, OR'd with the venue's). Serving is computed from it
/// and the clock, so no call needs Redis. Only an operator pause freezes serving:
/// the venue signal blocks claims while it lasts but does not move the count.
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
    private readonly string? _venueUrl = options.Value.VenueAvailabilityUrl;
    private const int PruneAbove = 1024;
    private static readonly TimeSpan PruneAge = TimeSpan.FromMinutes(1);

    private sealed record Slot(EventSnapshot? Value, DateTimeOffset At);

    private sealed class Entry
    {
        public readonly object Gate = new();
        public volatile Slot? Current;
        public TaskCompletionSource<EventSnapshot?>? InFlight;
        // Guarded by Gate except Venue, which is replaced whole.
        public volatile VenueSignal? Venue;
        public DateTimeOffset VenuePolledAt = DateTimeOffset.MinValue;
        public bool VenuePolling, VenueFailing;
    }

    private sealed record VenueSignal(bool Paused, bool SoldOut, DateTimeOffset At);
    private sealed record VenueAvailability(int Available, int Held);

    private readonly ConcurrentDictionary<string, Entry> _entries = new();

    /// Null when the event has no config.
    public async Task<EventSnapshot?> GetAsync(string eid)
    {
        var entry = EntryFor(eid);
        TaskCompletionSource<EventSnapshot?> flight;
        var owner = false;
        lock (entry.Gate)
        {
            if (entry.Current is { } c && clock.GetUtcNow() - c.At < RefreshInterval) return c.Value;
            if (entry.InFlight is null)
            {
                entry.InFlight = new(TaskCreationOptions.RunContinuationsAsynchronously);
                owner = true;
            }
            flight = entry.InFlight;
        }

        if (owner)
        {
            try { flight.SetResult(await LoadAsync(eid, entry)); }
            catch (Exception ex) { flight.SetException(ex); }
            finally { lock (entry.Gate) entry.InFlight = null; }
        }
        return await flight.Task;
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
            snap = new EventSnapshot(cfg, cfg.SoldOut || v?.SoldOut == true, cfg.Paused || v?.Paused == true);
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
                entry.Venue = null; // no seating plan (a general-admission sale): nothing to signal
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
