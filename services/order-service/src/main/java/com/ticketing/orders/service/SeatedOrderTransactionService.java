package com.ticketing.orders.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderSeat;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.entity.OrderType;
import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.event.OrderCreatedEvent;
import com.ticketing.orders.exception.NotFoundException;
import com.ticketing.orders.grpc.SeatDetail;
import com.ticketing.orders.kafka.KafkaTraceContext;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderSeatRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Encapsulates the transactional boundary for seated order creation (CP-12).
 *
 * <p>Extracted from {@link OrderService} to avoid the Spring AOP self-invocation
 * proxy bypass (audit finding C-01) — same pattern as {@link OrderTransactionService}
 * for the GA path.
 *
 * <p>Within a single {@code @Transactional} boundary this service:
 * <ol>
 *   <li>Looks up (or throws) the local OrderTicket replica.</li>
 *   <li>Persists the Order row with seated fields populated.</li>
 *   <li>Persists one OrderSeat row per seat returned by the venue gRPC response.</li>
 *   <li>Writes an {@code orders.order.created} outbox message including the seatIds.</li>
 * </ol>
 *
 * <p>If any step fails the entire transaction is rolled back.  The caller
 * ({@link OrderService}) is responsible for calling
 * {@code venueServiceClient.releaseSeatReservation} as compensation.
 */
@Service
public class SeatedOrderTransactionService {

    private static final Logger log = LoggerFactory.getLogger(SeatedOrderTransactionService.class);

    private final OrderRepository orderRepository;
    private final OrderTicketRepository orderTicketRepository;
    private final OrderSeatRepository orderSeatRepository;
    private final OutboxRepository outboxRepository;
    private final ObjectMapper objectMapper;

    @Value("${order.expiration.minutes:15}")
    private int expirationMinutes;

    public SeatedOrderTransactionService(
            OrderRepository orderRepository,
            OrderTicketRepository orderTicketRepository,
            OrderSeatRepository orderSeatRepository,
            OutboxRepository outboxRepository,
            ObjectMapper objectMapper) {
        this.orderRepository = orderRepository;
        this.orderTicketRepository = orderTicketRepository;
        this.orderSeatRepository = orderSeatRepository;
        this.outboxRepository = outboxRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Creates a seated order atomically: Order row + OrderSeat rows + outbox event.
     *
     * @param userId        authenticated user placing the order
     * @param ticketId      ticket being purchased
     * @param planId        seating plan UUID
     * @param reservationId idempotency key used in the venue gRPC call
     * @param quantity      number of seats being purchased
     * @param seats         seat details returned by the venue gRPC response
     * @param orderType     MANUAL_SEATED or AUTO_ASSIGN_SEATED
     * @param sectionId     section UUID for AUTO_ASSIGN_SEATED; null for MANUAL_SEATED
     * @return the created order as a response DTO (with seat summaries)
     * @throws NotFoundException if the local OrderTicket replica does not exist
     */
    @Transactional
    public OrderResponse createSeatedOrderTransactional(
            UUID userId,
            UUID ticketId,
            UUID planId,
            UUID reservationId,
            int quantity,
            List<SeatDetail> seats,
            OrderType orderType,
            UUID sectionId) {

        // Require the local ticket replica — for seated orders we do not have a
        // fresh gRPC title/price in the venue response, so we fall back to what
        // TicketEventConsumer has already written.  If it's missing, fail loudly.
        OrderTicket ticket = orderTicketRepository.findById(ticketId)
                .orElseThrow(() -> new NotFoundException(
                        "Local ticket replica not found for ticketId=" + ticketId
                        + ". Ensure TicketEventConsumer has processed the ticket before placing a seated order."));

        OffsetDateTime expiresAt = OffsetDateTime.now().plusMinutes(expirationMinutes);
        Order order = new Order(userId, OrderStatus.CREATED, expiresAt, ticket,
                reservationId, quantity, orderType, planId, sectionId);
        orderRepository.save(order);

        // Persist one row per seat returned by venue-service.
        List<OrderSeat> orderSeats = seats.stream()
                .map(seat -> new OrderSeat(
                        order.getId(),
                        UUID.fromString(seat.getSeatId()),
                        UUID.fromString(seat.getSectionId()),
                        seat.getSeatLabel(),
                        new BigDecimal(seat.getPrice())))
                .collect(Collectors.toList());
        orderSeatRepository.saveAll(orderSeats);

        List<String> seatIds = orderSeats.stream()
                .map(s -> s.getSeatId().toString())
                .collect(Collectors.toList());

        writeOutbox("orders.order.created", order.getId().toString(),
                new OrderCreatedEvent(
                        order.getId().toString(),
                        userId.toString(),
                        ticketId.toString(),
                        ticket.getTitle(),
                        ticket.getPrice(),
                        order.getExpiresAt().toString(),
                        reservationId.toString(),
                        quantity,
                        order.getVersion(),
                        seatIds));

        log.info("Seated order created orderId={} userId={} ticketId={} reservationId={} "
                        + "quantity={} orderType={} seats={}",
                order.getId(), userId, ticketId, reservationId, quantity, orderType, seatIds.size());

        return OrderResponse.from(order, orderSeats);
    }

    private void writeOutbox(String topic, String partitionKey, Object payload) {
        try {
            String json = objectMapper.writeValueAsString(payload);
                        outboxRepository.save(new OutboxMessage(
                                        topic,
                                        json,
                                        partitionKey,
                                        KafkaTraceContext.captureCurrentTraceHeaders()
                        ));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialise outbox payload", e);
        }
    }
}
