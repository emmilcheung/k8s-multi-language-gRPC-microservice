package com.ticketing.orders.event;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * CloudEvents-envelope-compatible POJO published to {@code orders.order.cancelled}.
 * Consumed by ticket-service (to release the reservation) and payment-service
 * (to void any pending charge).
 *
 * CP-05: added {@code reservationId} and {@code quantity} so ticket-service can use
 * the GA path (ReleaseReservation) instead of the legacy path (ReleaseTicket).
 *
 * CP-12: added {@code seatIds} (null for GA/legacy) so venue-service consumer can
 * release individual seat reservations.
 */
public class OrderCancelledEvent {

    private final String specversion = "1.0";
    private final String type = "orders.order.cancelled";
    private final String source = "order-service";
    private final String id = UUID.randomUUID().toString();
    private final String time = Instant.now().toString();
    private final String datacontenttype = "application/json";
    private final Data data;

    /** GA constructor — includes reservationId, quantity, and seatIds. */
    public OrderCancelledEvent(
            String orderId,
            String userId,
            String ticketId,
            String reservationId,
            int quantity,
            int version,
            List<String> seatIds) {
        this.data = new Data(orderId, userId, ticketId, reservationId, quantity, version, seatIds);
    }

    /** Legacy constructor — no reservationId, quantity, or seatIds (backward compat). */
    public OrderCancelledEvent(
            String orderId,
            String userId,
            String ticketId,
            int version) {
        this.data = new Data(orderId, userId, ticketId, null, 1, version, null);
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
            String reservationId,   // null for legacy orders
            int quantity,
            int version,
            List<String> seatIds    // null for GA/legacy orders
    ) {}
}
