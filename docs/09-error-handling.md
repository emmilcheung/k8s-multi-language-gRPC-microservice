# Error Handling

## Principles

- Errors are classified: **operational** (expected, recoverable — e.g. validation, not found) vs **programmer** (unexpected — e.g. null dereference, type error). Log and alert differently.
- Operational errors: return a meaningful structured error response to the caller. Do not log at `ERROR`.
- Programmer errors: log at `ERROR` with full context (stack trace, request ID, user ID), return a generic `500` to the caller. Alert on these.
- Never swallow errors silently (`catch {}` or `_ = err`).

## Retry & Resilience

- Apply **exponential back-off with jitter** for retries on transient failures (network timeouts, `503`, Kafka producer errors).
- Use a **circuit breaker** (e.g. resilience4j, go-circuit-breaker, opossum) on every gRPC client and outbound HTTP call.
  - Closed → Open when error rate exceeds threshold (e.g. 50% over 10 s window).
  - Open → Half-Open after a cooldown period.
  - Half-Open → Closed on success, back to Open on failure.
- Define and test **fallback behaviour** for every circuit breaker — return cached data, a default response, or a graceful degradation message.

## Timeouts

Set explicit timeouts at every layer:

| Layer | Typical timeout |
|---|---|
| Kong upstream | 60 s (adjust per route) |
| gRPC client read | 5 s |
| gRPC client write | 10 s |
| DB query | 30 s |
| Kafka producer send | 10 s |
| Redis command | 1 s |
| External HTTP call | 10 s |

Never use default (infinite) timeouts in any production code.
