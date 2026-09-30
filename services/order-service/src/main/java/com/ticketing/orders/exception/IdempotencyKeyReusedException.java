package com.ticketing.orders.exception;

/** Same Idempotency-Key, different request body (maps to 422 IDEMPOTENCY_KEY_REUSED). */
public class IdempotencyKeyReusedException extends RuntimeException {
    public IdempotencyKeyReusedException() {
        super("Idempotency-Key was already used with a different request body");
    }
}
