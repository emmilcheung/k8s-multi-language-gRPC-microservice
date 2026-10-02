package com.ticketing.orders.exception;

/** Request-level validation failure that is not a bean-validation error (maps to 400 VALIDATION_FAILED). */
public class ValidationFailedException extends RuntimeException {
    public ValidationFailedException(String message) {
        super(message);
    }
}
