package com.ticketing.orders.event;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * CloudEvents-envelope-compatible POJO published to {@code orders.order.completed}.
 *
 * CP-05: this event is emitted by order-service when a payment is captured
 * (triggered by PaymentEventConsumer).  ticket-service consumes it to call
 * FinalizeReservation(reservationId, orderId), which transitions the reservation
 * from RESERVED to SOLD and decrements the per-user reserved count.
 *
 * CP-12: added {@code seatIds} (null for GA orders) so venue-service consumer can
 * finalize individual seat reservations when payment is captured.
 */
public class OrderCompletedEvent {

    private final String specversion = "1.0";
    private final String type = "orders.order.completed";
    private final String source = "order-service";
    private final String id = UUID.randomUUID().toString();
    private final String time = Instant.now().toString();
    private final String datacontenttype = "application/json";
    private final Data data;

    public OrderCompletedEvent(
            String orderId,
            String userId,
            String ticketId,
            String reservationId,
            int quantity,
            int version,
            List<String> seatIds) {
        this.data = new Data(orderId, userId, ticketId, reservationId, quantity, version, seatIds);
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
            String reservationId,
            int quantity,
            int version,
            List<String> seatIds    // null for GA orders
    ) {}
}
