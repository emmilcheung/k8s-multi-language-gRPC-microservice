package com.ticketing.orders.statemachine;

/**
 * Events that drive the order state machine.
 */
public enum OrderEvent {
    /** User cancels the order, or the order expires. */
    CANCEL,
    /** Payment has been captured. */
    PAYMENT_CAPTURED
}
