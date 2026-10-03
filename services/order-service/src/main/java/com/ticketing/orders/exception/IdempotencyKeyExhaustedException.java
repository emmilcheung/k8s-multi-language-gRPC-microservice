package com.ticketing.orders.exception;

/**
 * The reservation derived from this Idempotency-Key was already released (a compensated
 * failure), so it cannot be reserved again. The client must retry with a new key
 * (maps to 409 IDEMPOTENCY_KEY_EXHAUSTED).
 */
public class IdempotencyKeyExhaustedException extends RuntimeException {
    public IdempotencyKeyExhaustedException() {
        super("The reservation for this Idempotency-Key was already released; retry with a new key");
    }
}
