namespace QueueService.Tokens;

public sealed record PreQueueTicket(string Eid, string Mid, double R, long? Pos, string Phase, long Iat);
public sealed record AdmissionToken(string Eid, string Mid, long Iat, long Exp, string Nonce);
