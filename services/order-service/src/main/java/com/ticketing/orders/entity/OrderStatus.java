package com.ticketing.orders.entity;

/**
 * Valid status values for an order.
 * Maps 1-to-1 with the state machine states.
 */
public enum OrderStatus {
    CREATED,
    AWAITING_PAYMENT,
    COMPLETE,
    CANCELLED
}
