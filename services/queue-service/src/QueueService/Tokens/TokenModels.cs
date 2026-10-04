namespace QueueService.Tokens;

public sealed record PreQueueTicket(string Eid, string Mid, double R, long? Pos, string Phase, long Iat);
/// Sub is null on the admission token a claim returns, and set on the purchase
/// pass minted when a logged-in account redeems it (Kong checks it against the JWT).
public sealed record AdmissionToken(string Eid, string Mid, long Iat, long Exp, string Nonce, string? Sub = null);
