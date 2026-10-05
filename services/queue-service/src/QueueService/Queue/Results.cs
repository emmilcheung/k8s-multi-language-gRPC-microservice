using QueueService.Tokens;

namespace QueueService.Queue;

/// Thrown when an operation references an event id that has no config in Redis.
/// Mapped to HTTP 404 by EventNotFoundExceptionHandler (never a 500).
public sealed class EventNotFoundException(string eid)
    : Exception($"event '{eid}' not configured");

/// Thrown when the pre-queue is at its hard size cap. Mapped to HTTP 503.
public sealed class QueueFullException(string eid)
    : Exception($"event '{eid}' pre-queue is full");

/// Outcome of redeeming an admission token for a purchase pass.
public enum RedeemOutcome { Invalid, Ok, AlreadyUsed, OtherAccount }

public sealed record EnqueueResult(PreQueueTicket Ticket, string Phase, long? Position, EventConfig Config);
public sealed record StatusResult(PreQueueTicket Ticket, long Position, long Serving, bool Admitted, double WaitSeconds,
    bool SoldOut = false, bool Paused = false);
/// Refused (not merely early) when SoldOut or Paused is set.
public sealed record ClaimResult(bool Admitted, string? Token, PreQueueTicket Ticket,
    bool SoldOut = false, bool Paused = false);
public sealed record RedeemResult(RedeemOutcome Outcome, string? Pass = null);
public sealed record ServingResult(long Serving, double Rate, bool SoldOut, bool Paused);
