package com.ticketing.orders.statemachine;

/**
 * States in the order lifecycle state machine.
 */
public enum OrderState {
    CREATED,
    AWAITING_PAYMENT,
    COMPLETE,
    CANCELLED
}
