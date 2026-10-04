package com.ticketing.orders.entity;

/** Why an order ended {@link OrderStatus#CANCELLED}. */
public enum CancelReason {
    /** The payment window ran out. */
    EXPIRED,
    /** payment-service reported the charge failed. */
    PAYMENT_FAILED,
    /** The buyer cancelled the order. */
    CANCELLED_BY_USER,
    /**
     * Payment was captured but the reservation was already gone, so the order
     * can never be fulfilled; a refund has been requested for the payment.
     */
    UNFULFILLABLE_REFUNDED
}
