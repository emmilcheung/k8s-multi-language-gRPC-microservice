package com.ticketing.orders.event;

import java.time.Instant;
import java.util.UUID;

/**
 * CloudEvents-envelope-compatible POJO published to {@code orders.order.cancelled}.
 * Consumed by ticket-service (to release the reservation) and payment-service
 * (to void any pending charge).
 */
public class OrderCancelledEvent {

    private final String specversion = "1.0";
    private final String type = "orders.order.cancelled";
    private final String source = "order-service";
    private final String id = UUID.randomUUID().toString();
    private final String time = Instant.now().toString();
    private final String datacontenttype = "application/json";
    private final Data data;

    public OrderCancelledEvent(
            String orderId,
            String userId,
            String ticketId,
            int version) {
        this.data = new Data(orderId, userId, ticketId, version);
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

    public record Data(
            String orderId,
            String userId,
            String ticketId,
            int version
    ) {}
}
