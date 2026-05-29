package com.ticketing.orders.dto;

import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderSeat;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderType;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

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
    private OrderType orderType;
    private UUID planId;
    private List<SeatSummary> seats;

    /**
     * Factory — GA orders have no associated seats; uses an empty list.
     */
    public static OrderResponse from(Order order) {
        return from(order, Collections.emptyList());
    }

    /**
     * Factory — includes the per-seat breakdown for seated orders.
     *
     * @param order the persisted order
     * @param orderSeats the seats associated with this order (empty for GA)
     */
    public static OrderResponse from(Order order, List<OrderSeat> orderSeats) {
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
        r.orderType = order.getOrderType();
        r.planId = order.getPlanId();
        if (order.getTicket() != null) {
            r.ticket = new TicketSummary(
                    order.getTicket().getId(),
                    order.getTicket().getTitle(),
                    order.getTicket().getPrice(),
                    order.getTicket().getStartsAt()
            );
        }
        r.seats = orderSeats == null
                ? Collections.emptyList()
                : orderSeats.stream()
                        .map(s -> new SeatSummary(s.getSeatId(), s.getSectionId(),
                                s.getSeatLabel(), s.getPrice()))
                        .collect(Collectors.toList());
        return r;
    }

    // ── nested DTO ────────────────────────────────────────────────────────────

    public record TicketSummary(UUID id, String title, BigDecimal price, OffsetDateTime startsAt) {}

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
    public OrderType getOrderType() { return orderType; }
    public UUID getPlanId() { return planId; }
    public List<SeatSummary> getSeats() { return seats; }
}
