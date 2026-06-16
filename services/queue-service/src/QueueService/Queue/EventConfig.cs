namespace QueueService.Queue;

public sealed record EventConfig(string Eid, DateTimeOffset T0, double Rate, bool Armed, long? PreQueueSize);
