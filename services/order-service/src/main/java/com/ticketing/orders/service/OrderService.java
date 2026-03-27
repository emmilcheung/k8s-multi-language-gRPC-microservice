package com.ticketing.orders.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.event.OrderCancelledEvent;
import com.ticketing.orders.exception.BadRequestException;
import com.ticketing.orders.exception.ConflictException;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.exception.NotFoundException;
import com.ticketing.orders.grpc.TicketServiceClient;
import com.ticketing.orders.grpc.ValidateTicketResponse;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.redisson.api.RLock;
import org.redisson.api.RedissonClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

// Audit C-01 fix: transactional order creation is delegated to OrderTransactionService
// so that Spring's AOP proxy intercepts the @Transactional boundary correctly.
// Direct self-invocation (this.createOrderTransactional()) bypasses the proxy.

/**
 * Core business logic for order lifecycle.
 *
 * Design decisions:
 * - All state changes and outbox writes happen in a single @Transactional boundary
 *   to guarantee the outbox pattern (no event lost, no partial state).
 * - gRPC ticket validation happens outside the transaction (network I/O should not
 *   hold a DB connection). The ticket local-replica is fetched from the DB inside.
 * - Authorisation (ownership check) happens before any write.
 * - The transactional order creation is delegated to {@link OrderTransactionService}
 *   to avoid the Spring AOP self-invocation proxy bypass (audit finding C-01).
 */
@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final OrderRepository orderRepository;
    private final OutboxRepository outboxRepository;
    private final TicketServiceClient ticketServiceClient;
    private final ObjectMapper objectMapper;
    private final RedissonClient redissonClient;
    private final OrderTransactionService orderTransactionService;

    public OrderService(
            OrderRepository orderRepository,
            OutboxRepository outboxRepository,
            TicketServiceClient ticketServiceClient,
            ObjectMapper objectMapper,
            RedissonClient redissonClient,
            OrderTransactionService orderTransactionService) {
        this.orderRepository = orderRepository;
        this.outboxRepository = outboxRepository;
        this.ticketServiceClient = ticketServiceClient;
        this.objectMapper = objectMapper;
        this.redissonClient = redissonClient;
        this.orderTransactionService = orderTransactionService;
    }

    // ── Create ────────────────────────────────────────────────────────────────

    /**
     * Create a new order for a ticket.
     *
     * Steps:
     * 1. Call gRPC ticket-service to validate ticket exists and is available (outside TX).
     * 2. Delegate to OrderTransactionService which atomically: checks no active order
     *    already exists, upserts the local ticket replica, creates the order, and writes
     *    the outbox message — all within a single @Transactional boundary.
     */
    public OrderResponse createOrder(UUID userId, CreateOrderRequest request) {
        UUID ticketId = request.getTicketId();
        String lockKey = "order-service:lock:ticket:" + ticketId;
        RLock lock = redissonClient.getLock(lockKey);

        boolean acquired = false;
        try {
            acquired = lock.tryLock(0, 5, TimeUnit.SECONDS);
            if (!acquired) {
                throw new ConflictException(
                        "Another order for ticket " + ticketId + " is being processed. Please retry.");
            }

            // Validate ticket via gRPC BEFORE opening a DB transaction.
            ValidateTicketResponse grpcTicket = ticketServiceClient.validateAvailability(ticketId.toString());

            // Delegate to the separate service bean so Spring's AOP proxy applies
            // @Transactional correctly (fixes audit finding C-01: self-invocation bypass).
            return orderTransactionService.createOrderTransactional(userId, ticketId, grpcTicket);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ConflictException("Order creation interrupted for ticket " + ticketId);
        } finally {
            if (acquired && lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
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
                new OrderCancelledEvent(
                        order.getId().toString(),
                        userId.toString(),
                        order.getTicket().getId().toString(),
                        order.getVersion()
                ));

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
     */
    @Transactional
    public void markComplete(UUID orderId) {
        orderRepository.findByIdWithTicket(orderId).ifPresent(order -> {
            if (order.isAwaitingPayment()) {
                order.setStatus(OrderStatus.COMPLETE);
                orderRepository.save(order);
                log.info("Order completed orderId={}", orderId);
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
                        new OrderCancelledEvent(
                                order.getId().toString(),
                                order.getUserId().toString(),
                                order.getTicket().getId().toString(),
                                order.getVersion()
                        ));

                log.info("Order expired orderId={}", orderId);
            }
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

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
