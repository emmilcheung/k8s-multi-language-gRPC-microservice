package com.ticketing.orders.service;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderSeat;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderType;
import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.event.OrderCancelledEvent;
import com.ticketing.orders.event.OrderCompletedEvent;
import com.ticketing.orders.exception.BadRequestException;
import com.ticketing.orders.exception.ConflictException;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.exception.NotFoundException;
import com.ticketing.orders.grpc.AutoAssignAndReserveResponse;
import com.ticketing.orders.grpc.ReserveHeldSeatsResponse;
import com.ticketing.orders.grpc.ReserveQuotaResponse;
import com.ticketing.orders.grpc.TicketServiceClient;
import com.ticketing.orders.grpc.VenueServiceClient;
import com.ticketing.orders.kafka.KafkaTraceContext;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderSeatRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

// CP-05: replaced Redisson distributed lock + ValidateTicketAvailability with a
// synchronous ReserveQuota gRPC call. Atomicity is now enforced by the inventory
// owner (ticket-service) through the reservation ledger, not by an application-level
// lock.  If the DB transaction fails after a successful reservation, a synchronous
// ReleaseReservation compensation call is made immediately.
//
// CP-12: added createSeatedOrder() for MANUAL_SEATED and AUTO_ASSIGN_SEATED flows
// backed by VenueServiceClient RPCs.

/**
 * Core business logic for order lifecycle.
 *
 * <p>Design decisions:
 * <ul>
 *   <li>All state changes and outbox writes happen in a single {@code @Transactional} boundary
 *       to guarantee the outbox pattern (no event lost, no partial state).</li>
 *   <li>gRPC calls happen outside the transaction (network I/O should not hold a DB connection).
 *       Compensation is called synchronously on TX failure.</li>
 *   <li>Authorisation (ownership check) happens before any write.</li>
 *   <li>The transactional creation is delegated to {@link OrderTransactionService} (GA) or
 *       {@link SeatedOrderTransactionService} (seated) to avoid the Spring AOP self-invocation
 *       proxy bypass (audit finding C-01).</li>
 * </ul>
 */
@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    @Value("${order.expiration.minutes:15}")
    private int expirationMinutes;

    private final OrderRepository orderRepository;
    private final OrderSeatRepository orderSeatRepository;
    private final OutboxRepository outboxRepository;
    private final TicketServiceClient ticketServiceClient;
    private final VenueServiceClient venueServiceClient;
    private final ObjectMapper objectMapper;
    private final OrderTransactionService orderTransactionService;
    private final SeatedOrderTransactionService seatedOrderTransactionService;

    public OrderService(
            OrderRepository orderRepository,
            OrderSeatRepository orderSeatRepository,
            OutboxRepository outboxRepository,
            TicketServiceClient ticketServiceClient,
            VenueServiceClient venueServiceClient,
            ObjectMapper objectMapper,
            OrderTransactionService orderTransactionService,
            SeatedOrderTransactionService seatedOrderTransactionService) {
        this.orderRepository = orderRepository;
        this.orderSeatRepository = orderSeatRepository;
        this.outboxRepository = outboxRepository;
        this.ticketServiceClient = ticketServiceClient;
        this.venueServiceClient = venueServiceClient;
        this.objectMapper = objectMapper;
        this.orderTransactionService = orderTransactionService;
        this.seatedOrderTransactionService = seatedOrderTransactionService;
    }

    // ── Create (GA) ───────────────────────────────────────────────────────────

    /**
     * Create a new order for a ticket using the GA reservation flow.
     *
     * <p>Steps:
     * <ol>
     *   <li>Generate a reservationId (idempotency key).</li>
     *   <li>Call gRPC ReserveQuota on ticket-service BEFORE opening a DB transaction.</li>
     *   <li>If reservation succeeds, delegate to OrderTransactionService which atomically
     *       creates the order and outbox message within a single {@code @Transactional} boundary.</li>
     *   <li>If the DB transaction fails, immediately call ReleaseReservation as compensation.</li>
     * </ol>
     */
    public OrderResponse createOrder(UUID userId, CreateOrderRequest request) {
        UUID ticketId = request.getTicketId();
        int quantity = request.getQuantity();
        UUID reservationId = UUID.randomUUID();

        // Set reservation expiry to order expiry + a small buffer so that ticket-service's
        // expiry worker does not reclaim the reservation before the order TX commits.
        Instant reservationExpiresAt = Instant.now().plus(expirationMinutes + 1, ChronoUnit.MINUTES);

        // Step 1: reserve quota outside the DB transaction (network I/O must not hold a
        // connection).  This is the authoritative availability check — no Redisson lock needed.
        ReserveQuotaResponse reserveResponse = ticketServiceClient.reserveQuota(
                ticketId.toString(), reservationId, userId, quantity, reservationExpiresAt);

        // Step 2: create order + outbox in a single DB transaction.
        try {
            return orderTransactionService.createOrderTransactional(
                    userId, ticketId, reserveResponse, reservationId, quantity);
        } catch (Exception e) {
            // Compensation: release the reservation so inventory is returned immediately.
            log.error("Order TX failed after successful ReserveQuota — compensating reservationId={} ticketId={}",
                    reservationId, ticketId, e);
            ticketServiceClient.releaseReservation(reservationId, "COMPENSATION");
            throw e;
        }
    }

    // ── Create (Seated) ───────────────────────────────────────────────────────

    /**
     * Create a new order using the seated reservation flow (CP-12).
     *
     * <p>Supports two sub-flows:
     * <ul>
     *   <li><b>MANUAL_SEATED</b> — client specifies exact seatIds it has held; calls
     *       {@code ReserveHeldSeats} on venue-service.</li>
     *   <li><b>AUTO_ASSIGN_SEATED</b> — client specifies a sectionId and quantity; calls
     *       {@code AutoAssignAndReserve} on venue-service which picks the best seats.</li>
     * </ul>
     *
     * <p>WS4: validates that the order type matches the plan's assignment mode.
     * The seller's mode choice is inviolable — buyers cannot override it.
     *
     * <p>If the gRPC call succeeds but the DB transaction fails, a best-effort compensation
     * call to {@code ReleaseSeatReservation} is made so seats are not held indefinitely.
     */
    public OrderResponse createSeatedOrder(UUID userId, CreateOrderRequest request) {
        request.validate();

        UUID ticketId = request.getTicketId();
        int quantity = request.getQuantity();
        OrderType orderType = request.determineOrderType();

        UUID reservationId = UUID.randomUUID();
        Instant reservationExpiresAt = Instant.now().plus(expirationMinutes + 1, ChronoUnit.MINUTES);

        // WS4: Fetch plan and validate assignment mode matches the order type.
        String planId = request.getPlanId();
        var planResponse = venueServiceClient.getSeatingPlan(planId);
        String assignmentMode = planResponse.getAssignmentMode();

        if ("auto".equals(assignmentMode) && orderType == OrderType.MANUAL_SEATED) {
            throw new BadRequestException(
                    "This seating plan uses automatic assignment. Do not provide explicit seat IDs.");
        }

        if ("manual".equals(assignmentMode) && orderType == OrderType.AUTO_ASSIGN_SEATED) {
            throw new BadRequestException(
                    "This seating plan requires manual seat selection. Use the manual flow with specific seat IDs.");
        }

        if (orderType == OrderType.MANUAL_SEATED) {
            List<String> seatIds = request.getSeatIds();

            ReserveHeldSeatsResponse reserveResponse = venueServiceClient.reserveHeldSeats(
                    planId, ticketId.toString(), reservationId, userId, seatIds, reservationExpiresAt);

            if (!reserveResponse.getSuccess()) {
                List<String> unavailable = reserveResponse.getUnavailableSeatIdsList();
                throw new ConflictException("Some seats are no longer available: " + unavailable);
            }

            try {
                return seatedOrderTransactionService.createSeatedOrderTransactional(
                        userId, ticketId, UUID.fromString(planId),
                        reservationId, quantity, reserveResponse.getSeatsList(),
                        OrderType.MANUAL_SEATED, null);
            } catch (Exception e) {
                log.error("Seated order TX failed after ReserveHeldSeats — compensating "
                        + "reservationId={} ticketId={}", reservationId, ticketId, e);
                venueServiceClient.releaseSeatReservation(reservationId, "COMPENSATION");
                throw e;
            }
        }

        // AUTO_ASSIGN_SEATED
        String sectionId = request.getSectionId();

        AutoAssignAndReserveResponse assignResponse = venueServiceClient.autoAssignAndReserve(
                planId, ticketId.toString(), sectionId, reservationId, userId,
                quantity, reservationExpiresAt);

        try {
            return seatedOrderTransactionService.createSeatedOrderTransactional(
                    userId, ticketId, UUID.fromString(planId),
                    reservationId, quantity, assignResponse.getSeatsList(),
                    OrderType.AUTO_ASSIGN_SEATED, UUID.fromString(sectionId));
        } catch (Exception e) {
            log.error("Seated order TX failed after AutoAssignAndReserve — compensating "
                    + "reservationId={} ticketId={}", reservationId, ticketId, e);
            venueServiceClient.releaseSeatReservation(reservationId, "COMPENSATION");
            throw e;
        }
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public OrderResponse findById(UUID orderId) {
        return orderRepository.findByIdWithTicket(orderId)
                .map(order -> {
                    List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(orderId);
                    return OrderResponse.from(order, seats);
                })
                .orElse(null);
    }

    /**
     * Batch-load orders by a list of IDs in a single DB round-trip.
     *
     * <p>Used by the federation entity fetcher to avoid N+1 queries when Apollo
     * Router resolves a batch of {@code Order} entity references.  The returned
     * map preserves lookup by ID so the caller can fan results back in the order
     * the representations were received.
     *
     * @param orderIds list of order UUIDs to fetch
     * @return map from UUID → OrderResponse; missing orders are absent from the map
     */
    @Transactional(readOnly = true)
    public java.util.Map<UUID, OrderResponse> findByIds(List<UUID> orderIds) {
        // JpaRepository.findAllById issues a single WHERE id IN (...) query.
        List<Order> orders = orderRepository.findAllById(orderIds);
        java.util.Map<UUID, OrderResponse> result = new java.util.HashMap<>(orders.size());
        for (Order order : orders) {
            List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(order.getId());
            result.put(order.getId(), OrderResponse.from(order, seats));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public OrderResponse getOrder(UUID orderId, UUID userId) {
        Order order = orderRepository.findByIdWithTicket(orderId)
                .orElseThrow(() -> new NotFoundException("Order not found: " + orderId));
        if (!order.getUserId().equals(userId)) {
            throw new ForbiddenException("You do not own this order");
        }
        List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(orderId);
        return OrderResponse.from(order, seats);
    }

    @Transactional(readOnly = true)
    public List<OrderResponse> listOrders(UUID userId) {
        return orderRepository.findAllByUserIdWithTicket(userId)
                .stream()
                .map(order -> {
                    List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(order.getId());
                    return OrderResponse.from(order, seats);
                })
                .collect(Collectors.toList());
    }

    // ── Cancel ────────────────────────────────────────────────────────────────

    @Transactional
    public OrderResponse cancelOrder(UUID orderId, UUID userId) {
        Order order = orderRepository.findByIdWithTicket(orderId)
                .orElseThrow(() -> new NotFoundException("Order not found: " + orderId));
        if (!order.getUserId().equals(userId)) {
            throw new ForbiddenException("You do not own this order");
        }
        if (order.isTerminal()) {
            throw new BadRequestException("Order is already in a terminal state: " + order.getStatus());
        }

        order.setStatus(OrderStatus.CANCELLED);
        orderRepository.save(order);

        List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(orderId);
        writeOutbox("orders.order.cancelled", order.getId().toString(),
                buildCancelledEventWithSeats(order, seats));

        log.info("Order cancelled orderId={} userId={}", orderId, userId);
        return OrderResponse.from(order, seats);
    }

    // ── Internal state transitions (called by Kafka consumers) ───────────────

    /**
     * Mark an order as AWAITING_PAYMENT (called when expiration timer starts).
     * No-op if the order is already terminal.
     */
    @Transactional
    public void markAwaitingPayment(UUID orderId) {
        orderRepository.findByIdWithTicket(orderId).ifPresent(order -> {
            if (!order.isTerminal() && order.getStatus() == OrderStatus.CREATED) {
                order.setStatus(OrderStatus.AWAITING_PAYMENT);
                orderRepository.save(order);
                log.info("Order moved to AWAITING_PAYMENT orderId={}", orderId);
            }
        });
    }

    /**
     * Mark an order as COMPLETE after payment captured.
     *
     * <p>Emits {@code orders.order.completed} so ticket-service can finalize the GA
     * reservation (RESERVED → SOLD). For seated orders, also calls venue-service's
     * {@code FinalizeSeatReservation} directly (best-effort, does not affect the TX).
     */
    @Transactional
    public void markComplete(UUID orderId) {
        orderRepository.findByIdWithTicket(orderId).ifPresent(order -> {
            if (order.isAwaitingPayment()) {
                order.setStatus(OrderStatus.COMPLETE);
                orderRepository.save(order);

                List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(orderId);
                List<String> seatIds = seats.stream()
                        .map(s -> s.getSeatId().toString())
                        .collect(Collectors.toList());

                writeOutbox("orders.order.completed", order.getId().toString(),
                        new OrderCompletedEvent(
                                order.getId().toString(),
                                order.getUserId().toString(),
                                order.getTicket().getId().toString(),
                                order.getReservationId() != null ? order.getReservationId().toString() : null,
                                order.getQuantity(),
                                order.getVersion(),
                                seatIds.isEmpty() ? null : seatIds
                        ));

                // For seated orders, proactively call venue-service to finalize the reservation
                // without waiting for the Kafka consumer on the venue side.
                if (order.getOrderType() != OrderType.GA && order.getReservationId() != null) {
                    venueServiceClient.finalizeSeatReservation(
                            order.getReservationId(), order.getId().toString());
                }

                log.info("Order completed orderId={} reservationId={} orderType={}",
                        orderId, order.getReservationId(), order.getOrderType());
            }
        });
    }

    /**
     * Cancel an order after a payment failure event from payment-service.
     *
     * <p>Idempotent: only non-terminal payable orders are cancelled. This mirrors the
     * expiration-driven cancellation path but is triggered explicitly by payment failure.
     */
    @Transactional
    public void markPaymentFailed(UUID orderId) {
        orderRepository.findByIdWithTicket(orderId).ifPresent(order -> {
            if (order.isAwaitingPayment() && !order.isTerminal()) {
                order.setStatus(OrderStatus.CANCELLED);
                orderRepository.save(order);

                List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(orderId);
                writeOutbox("orders.order.cancelled", order.getId().toString(),
                        buildCancelledEventWithSeats(order, seats));

                log.info("Order cancelled after payment failure orderId={} reservationId={} orderType={}",
                        orderId, order.getReservationId(), order.getOrderType());
            }
        });
    }

    /**
     * Cancel an order due to expiration (called by ExpirationEventConsumer).
     * Emits an outbox cancellation event so other services react.
     */
    @Transactional
    public void expireOrder(UUID orderId) {
        orderRepository.findByIdWithTicket(orderId).ifPresent(order -> {
            if (!order.isTerminal()) {
                order.setStatus(OrderStatus.CANCELLED);
                orderRepository.save(order);

                List<OrderSeat> seats = orderSeatRepository.findAllByOrderId(orderId);
                writeOutbox("orders.order.cancelled", order.getId().toString(),
                        buildCancelledEventWithSeats(order, seats));

                log.info("Order expired orderId={}", orderId);
            }
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private OrderCancelledEvent buildCancelledEventWithSeats(Order order, List<OrderSeat> seats) {
        List<String> seatIds = seats.stream()
                .map(s -> s.getSeatId().toString())
                .collect(Collectors.toList());

        if (order.getReservationId() != null) {
            // GA and seated paths — include reservationId so consumers can release appropriately
            return new OrderCancelledEvent(
                    order.getId().toString(),
                    order.getUserId().toString(),
                    order.getTicket().getId().toString(),
                    order.getReservationId().toString(),
                    order.getQuantity(),
                    order.getVersion(),
                    seatIds.isEmpty() ? null : seatIds
            );
        }
        // Legacy path — no reservationId; ticket-service falls back to ReleaseTicket
        return new OrderCancelledEvent(
                order.getId().toString(),
                order.getUserId().toString(),
                order.getTicket().getId().toString(),
                order.getVersion()
        );
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
        } catch (JacksonException e) {
            // This should never happen for our simple POJOs — treat as programmer error
            throw new IllegalStateException("Failed to serialise outbox payload", e);
        }
    }
}
