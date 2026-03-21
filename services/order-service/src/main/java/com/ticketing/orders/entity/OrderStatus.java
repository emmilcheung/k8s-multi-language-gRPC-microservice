package com.ticketing.orders.entity;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Valid status values for an order.
 * Maps 1-to-1 with the state machine states.
 *
 * <p>{@link JsonValue} serializes the enum as lowercase JSON strings
 * (e.g. {@code "created"}) so the client-side TypeScript types match.</p>
 */
public enum OrderStatus {
    CREATED,
    AWAITING_PAYMENT,
    COMPLETE,
    CANCELLED;

    /**
     * Serialise as lowercase snake_case for the REST API.
     * e.g. {@code AWAITING_PAYMENT} → {@code "awaiting_payment"}.
     */
    @JsonValue
    public String toJson() {
        return name().toLowerCase();
    }
}
