package com.ticketing.orders.event;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * CloudEvents-envelope-compatible POJO published to {@code orders.order.created}.
 * The OutboxRelay serialises this to JSON and sets it as the Kafka message value.
 *
 * CP-05: added {@code reservationId} and {@code quantity} so ticket-service consumer
 * can identify the reservation associated with this order event.
 */
public class OrderCreatedEvent {

    private final String specversion = "1.0";
    private final String type = "orders.order.created";
    private final String source = "order-service";
    private final String id = UUID.randomUUID().toString();
    private final String time = Instant.now().toString();
    private final String datacontenttype = "application/json";
    private final Data data;

    public OrderCreatedEvent(
            String orderId,
            String userId,
            String ticketId,
            String ticketTitle,
            BigDecimal ticketPrice,
            String expiresAt,
            String reservationId,
            int quantity,
            int version) {
        this.data = new Data(orderId, userId, ticketId, ticketTitle, ticketPrice, expiresAt,
                reservationId, quantity, version);
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
            String ticketTitle,
            BigDecimal ticketPrice,
            String expiresAt,
            String reservationId,   // null for legacy orders
            int quantity,
            int version
    ) {}
}
