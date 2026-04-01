package com.ticketing.orders.dto;

import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

public class OrderResponse {

    private UUID id;
    private UUID userId;
    private OrderStatus status;
    private OffsetDateTime expiresAt;
    private TicketSummary ticket;
    private UUID reservationId;
    private int quantity;
    private int version;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;

    public static OrderResponse from(Order order) {
        OrderResponse r = new OrderResponse();
        r.id = order.getId();
        r.userId = order.getUserId();
        r.status = order.getStatus();
        r.expiresAt = order.getExpiresAt();
        r.reservationId = order.getReservationId();
        r.quantity = order.getQuantity();
        r.version = order.getVersion();
        r.createdAt = order.getCreatedAt();
        r.updatedAt = order.getUpdatedAt();
        if (order.getTicket() != null) {
            r.ticket = new TicketSummary(
                    order.getTicket().getId(),
                    order.getTicket().getTitle(),
                    order.getTicket().getPrice()
            );
        }
        return r;
    }

    // ── nested DTO ────────────────────────────────────────────────────────────

    public record TicketSummary(UUID id, String title, BigDecimal price) {}

    // ── accessors ─────────────────────────────────────────────────────────────

    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public OrderStatus getStatus() { return status; }
    public OffsetDateTime getExpiresAt() { return expiresAt; }
    public TicketSummary getTicket() { return ticket; }
    public UUID getReservationId() { return reservationId; }
    public int getQuantity() { return quantity; }
    public int getVersion() { return version; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }
}
