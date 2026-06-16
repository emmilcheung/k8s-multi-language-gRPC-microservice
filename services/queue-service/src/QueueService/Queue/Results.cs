using QueueService.Tokens;

namespace QueueService.Queue;

public sealed record EnqueueResult(PreQueueTicket Ticket, string Phase, long? Position, EventConfig Config);
public sealed record StatusResult(PreQueueTicket Ticket, long Position, long Serving, bool Admitted, double WaitSeconds);
public sealed record ClaimResult(bool Admitted, string? Token, PreQueueTicket Ticket);
