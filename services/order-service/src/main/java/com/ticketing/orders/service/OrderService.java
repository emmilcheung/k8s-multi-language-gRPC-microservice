package com.ticketing.orders.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.event.OrderCancelledEvent;
import com.ticketing.orders.event.OrderCreatedEvent;
import com.ticketing.orders.exception.BadRequestException;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.exception.NotFoundException;
import com.ticketing.orders.grpc.TicketServiceClient;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Core business logic for order lifecycle.
 *
 * Design decisions:
 * - All state changes and outbox writes happen in a single @Transactional boundary
 *   to guarantee the outbox pattern (no event lost, no partial state).
 * - gRPC ticket validation happens outside the transaction (network I/O should not
 *   hold a DB connection). The ticket local-replica is fetched from the DB inside.
 * - Authorisation (ownership check) happens before any write.
 */
@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private static final List<OrderStatus> NON_TERMINAL_STATUSES = List.of(
            OrderStatus.CREATED,
            OrderStatus.AWAITING_PAYMENT
    );

    private final OrderRepository orderRepository;
    private final OrderTicketRepository orderTicketRepository;
    private final OutboxRepository outboxRepository;
    private final TicketServiceClient ticketServiceClient;
    private final ObjectMapper objectMapper;

    @Value("${order.expiration.minutes:15}")
    private int expirationMinutes;

    public OrderService(
            OrderRepository orderRepository,
            OrderTicketRepository orderTicketRepository,
            OutboxRepository outboxRepository,
            TicketServiceClient ticketServiceClient,
            ObjectMapper objectMapper) {
        this.orderRepository = orderRepository;
        this.orderTicketRepository = orderTicketRepository;
        this.outboxRepository = outboxRepository;
        this.ticketServiceClient = ticketServiceClient;
        this.objectMapper = objectMapper;
    }

    // ── Create ────────────────────────────────────────────────────────────────

    /**
     * Create a new order for a ticket.
     *
     * Steps:
     * 1. Call gRPC ticket-service to validate ticket exists and is available (outside TX).
     * 2. In a single transaction: check no active order already exists for the ticket,
     *    fetch/create the local ticket replica, create the order, write outbox message.
     */
    public OrderResponse createOrder(UUID userId, CreateOrderRequest request) {
        UUID ticketId = request.getTicketId();

        // Validate ticket via gRPC BEFORE opening a DB transaction
        ticketServiceClient.validateAvailability(ticketId.toString());

        return createOrderTransactional(userId, ticketId);
    }

    @Transactional
    protected OrderResponse createOrderTransactional(UUID userId, UUID ticketId) {
        // Guard: reject if an active order already exists for this ticket
        boolean alreadyReserved = orderRepository
                .findActiveByTicketId(ticketId, List.of(OrderStatus.CANCELLED, OrderStatus.COMPLETE))
                .isPresent();
        if (alreadyReserved) {
            throw new BadRequestException("Ticket is already reserved by another order");
        }

        // Fetch the local ticket replica (populated by TicketEventConsumer)
        OrderTicket ticket = orderTicketRepository.findById(ticketId)
                .orElseThrow(() -> new NotFoundException("Ticket not found: " + ticketId));

        OffsetDateTime expiresAt = OffsetDateTime.now().plusMinutes(expirationMinutes);
        Order order = new Order(userId, OrderStatus.CREATED, expiresAt, ticket);
        orderRepository.save(order);

        // Write outbox message in the same transaction
        writeOutbox("orders.order.created", order.getId().toString(),
                new OrderCreatedEvent(
                        order.getId().toString(),
                        userId.toString(),
                        ticketId.toString(),
                        ticket.getTitle(),
                        ticket.getPrice(),
                        order.getExpiresAt().toString(),
                        order.getVersion()
                ));

        log.info("Order created orderId={} userId={} ticketId={}", order.getId(), userId, ticketId);
        return OrderResponse.from(order);
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
