package com.ticketing.orders.event;

import java.time.Instant;
import java.util.UUID;

/**
 * CloudEvents-envelope-compatible POJO published to {@code orders.order.unfulfillable}.
 *
 * <p>Emitted when a payment was captured for an order that can no longer be
 * fulfilled: the order was already cancelled, or its reservation had been
 * released. payment-service consumes it and refunds the payment, so nobody is
 * charged for a ticket they did not get.
 */
public class OrderUnfulfillableEvent {

    private final String specversion = "1.0";
    private final String type = "orders.order.unfulfillable";
    private final String source = "order-service";
    private final String id = UUID.randomUUID().toString();
    private final String time = Instant.now().toString();
    private final String datacontenttype = "application/json";
    private final Data data;

    public OrderUnfulfillableEvent(String orderId, String userId, String reason) {
        this.data = new Data(orderId, userId, reason);
    }

    // ── accessors ─────────────────────────────────────────────────────────────

    public String getSpecversion()      { return specversion; }
    public String getType()             { return type; }
    public String getSource()           { return source; }
    public String getId()               { return id; }
    public String getTime()             { return time; }
    public String getDatacontenttype()  { return datacontenttype; }
    public Data getData()               { return data; }

    // ── nested payload ────────────────────────────────────────────────────────

    /** {@code reason} is ORDER_CANCELLED or RESERVATION_RELEASED. */
    public record Data(String orderId, String userId, String reason) {}
}
