package com.ticketing.orders.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.event.OrderCancelledEvent;
import com.ticketing.orders.event.OrderCompletedEvent;
import com.ticketing.orders.exception.BadRequestException;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.exception.NotFoundException;
import com.ticketing.orders.grpc.ReserveQuotaResponse;
import com.ticketing.orders.grpc.TicketServiceClient;
import com.ticketing.orders.repository.OrderRepository;
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

// CP-05: replaced Redisson distributed lock + ValidateTicketAvailability with a
// synchronous ReserveQuota gRPC call. Atomicity is now enforced by the inventory
// owner (ticket-service) through the reservation ledger, not by an application-level
// lock.  If the DB transaction fails after a successful reservation, a synchronous
// ReleaseReservation compensation call is made immediately.

/**
 * Core business logic for order lifecycle.
 *
 * Design decisions:
 * - All state changes and outbox writes happen in a single @Transactional boundary
 *   to guarantee the outbox pattern (no event lost, no partial state).
 * - gRPC ReserveQuota happens outside the transaction (network I/O should not
 *   hold a DB connection). Compensation is called synchronously on TX failure.
 * - Authorisation (ownership check) happens before any write.
 * - The transactional order creation is delegated to {@link OrderTransactionService}
 *   to avoid the Spring AOP self-invocation proxy bypass (audit finding C-01).
 */
@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    @Value("${order.expiration.minutes:15}")
    private int expirationMinutes;

    private final OrderRepository orderRepository;
    private final OutboxRepository outboxRepository;
    private final TicketServiceClient ticketServiceClient;
    private final ObjectMapper objectMapper;
    private final OrderTransactionService orderTransactionService;

    public OrderService(
            OrderRepository orderRepository,
            OutboxRepository outboxRepository,
            TicketServiceClient ticketServiceClient,
            ObjectMapper objectMapper,
            OrderTransactionService orderTransactionService) {
        this.orderRepository = orderRepository;
        this.outboxRepository = outboxRepository;
        this.ticketServiceClient = ticketServiceClient;
        this.objectMapper = objectMapper;
        this.orderTransactionService = orderTransactionService;
    }

    // ── Create ────────────────────────────────────────────────────────────────

    /**
     * Create a new order for a ticket using the GA reservation flow.
     *
     * Steps:
     * 1. Generate a reservationId (idempotency key).
     * 2. Call gRPC ReserveQuota on ticket-service BEFORE opening a DB transaction.
     * 3. If reservation succeeds, delegate to OrderTransactionService which atomically
     *    creates the order and outbox message within a single @Transactional boundary.
     * 4. If the DB transaction fails, immediately call ReleaseReservation as compensation.
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

    // ── Read ──────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public OrderResponse getOrder(UUID orderId, UUID userId) {
        Order order = orderRepository.findByIdWithTicket(orderId)
                .orElseThrow(() -> new NotFoundException("Order not found: " + orderId));
        if (!order.getUserId().equals(userId)) {
            throw new ForbiddenException("You do not own this order");
        }
        return OrderResponse.from(order);
    }

    @Transactional(readOnly = true)
    public List<OrderResponse> listOrders(UUID userId) {
        return orderRepository.findAllByUserIdWithTicket(userId)
                .stream()
                .map(OrderResponse::from)
                .toList();
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

        writeOutbox("orders.order.cancelled", order.getId().toString(),
                buildCancelledEvent(order));

        log.info("Order cancelled orderId={} userId={}", orderId, userId);
        return OrderResponse.from(order);
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
     * Emits an orders.order.completed outbox event so ticket-service can finalize
     * the reservation (GA path: transitions RESERVED → SOLD, decrements per-user count).
     */
    @Transactional
    public void markComplete(UUID orderId) {
        orderRepository.findByIdWithTicket(orderId).ifPresent(order -> {
            if (order.isAwaitingPayment()) {
                order.setStatus(OrderStatus.COMPLETE);
                orderRepository.save(order);

                writeOutbox("orders.order.completed", order.getId().toString(),
                        new OrderCompletedEvent(
                                order.getId().toString(),
                                order.getUserId().toString(),
                                order.getTicket().getId().toString(),
                                order.getReservationId() != null ? order.getReservationId().toString() : null,
                                order.getQuantity(),
                                order.getVersion()
                        ));

                log.info("Order completed orderId={} reservationId={}", orderId, order.getReservationId());
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

                writeOutbox("orders.order.cancelled", order.getId().toString(),
                        buildCancelledEvent(order));

                log.info("Order expired orderId={}", orderId);
            }
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private OrderCancelledEvent buildCancelledEvent(Order order) {
        if (order.getReservationId() != null) {
            // GA path — include reservationId so ticket-service uses ReleaseReservation
            return new OrderCancelledEvent(
                    order.getId().toString(),
                    order.getUserId().toString(),
                    order.getTicket().getId().toString(),
                    order.getReservationId().toString(),
                    order.getQuantity(),
                    order.getVersion()
            );
        }
        // Legacy path — no reservationId, ticket-service falls back to ReleaseTicket
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
            outboxRepository.save(new OutboxMessage(topic, json, partitionKey));
        } catch (JsonProcessingException e) {
            // This should never happen for our simple POJOs — treat as programmer error
            throw new IllegalStateException("Failed to serialise outbox payload", e);
        }
    }
}
