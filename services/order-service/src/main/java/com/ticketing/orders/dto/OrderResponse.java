package com.ticketing.orders.dto;

import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderSeat;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderType;

import java.math.BigDecimal;
import java.math.RoundingMode;
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
    private String subtotal;
    private String serviceFee;
    private String facilityFee;
    private String tax;
    private String total;

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
        computeFees(r, order, orderSeats);
        return r;
    }

    /**
     * Compute fee breakdown (subtotal, service fee, facility fee, tax, total).
     * Fees are computed on read as a pure function of the order's subtotal and ticket count.
     *
     * @param response the response to populate
     * @param order the persisted order
     * @param orderSeats the seats associated with the order (empty for GA)
     */
    private static void computeFees(OrderResponse response, Order order, List<OrderSeat> orderSeats) {
        // Determine subtotal in cents
        int subtotalCents;
        int ticketCount;

        if (orderSeats != null && !orderSeats.isEmpty()) {
            // Seated order: sum of seat prices in cents
            subtotalCents = orderSeats.stream()
                    .mapToInt(seat -> {
                        BigDecimal price = seat.getPrice();
                        if (price == null) {
                            return 0;
                        }
                        return price.multiply(BigDecimal.valueOf(100))
                                .setScale(0, RoundingMode.HALF_UP)
                                .intValueExact();
                    })
                    .sum();
            ticketCount = orderSeats.size();
        } else {
            // GA order: ticket price × quantity
            if (order.getTicket() != null && order.getTicket().getPrice() != null) {
                BigDecimal ticketPrice = order.getTicket().getPrice();
                int ticketPriceCents = ticketPrice.multiply(BigDecimal.valueOf(100))
                        .setScale(0, RoundingMode.HALF_UP)
                        .intValueExact();
                subtotalCents = ticketPriceCents * order.getQuantity();
            } else {
                subtotalCents = 0;
            }
            ticketCount = order.getQuantity();
        }

        // Compute fees
        int serviceFeeCents = Math.round(subtotalCents * 0.10f);
        int facilityFeeCents = ticketCount * 150;  // $1.50 per ticket
        int taxCents = 0;
        int totalCents = subtotalCents + serviceFeeCents + facilityFeeCents + taxCents;

        // Convert cents to dollar strings
        response.subtotal = BigDecimal.valueOf(subtotalCents, 2).toPlainString();
        response.serviceFee = BigDecimal.valueOf(serviceFeeCents, 2).toPlainString();
        response.facilityFee = BigDecimal.valueOf(facilityFeeCents, 2).toPlainString();
        response.tax = BigDecimal.valueOf(taxCents, 2).toPlainString();
        response.total = BigDecimal.valueOf(totalCents, 2).toPlainString();
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
    public String getSubtotal() { return subtotal; }
    public String getServiceFee() { return serviceFee; }
    public String getFacilityFee() { return facilityFee; }
    public String getTax() { return tax; }
    public String getTotal() { return total; }
}
