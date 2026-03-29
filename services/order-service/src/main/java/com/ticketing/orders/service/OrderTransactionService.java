package com.ticketing.orders.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.event.OrderCreatedEvent;
import com.ticketing.orders.exception.BadRequestException;
import com.ticketing.orders.grpc.ValidateTicketResponse;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * Encapsulates the transactional boundary for order creation.
 *
 * Extracted from {@link OrderService} to fix the Spring AOP self-invocation problem:
 * when a bean calls its own {@code @Transactional} method directly, Spring's proxy
 * is bypassed and the transaction annotation has no effect. By placing this logic in
 * a separate {@code @Service} bean, the call goes through the proxy and the transaction
 * is correctly applied — ensuring the order row and the outbox row are always written
 * atomically.
 *
 * See audit finding C-01.
 */
@Service
public class OrderTransactionService {

    private static final Logger log = LoggerFactory.getLogger(OrderTransactionService.class);

    private final OrderRepository orderRepository;
    private final OrderTicketRepository orderTicketRepository;
    private final OutboxRepository outboxRepository;
    private final ObjectMapper objectMapper;

    @Value("${order.expiration.minutes:15}")
    private int expirationMinutes;

    public OrderTransactionService(
            OrderRepository orderRepository,
            OrderTicketRepository orderTicketRepository,
            OutboxRepository outboxRepository,
            ObjectMapper objectMapper) {
        this.orderRepository = orderRepository;
        this.orderTicketRepository = orderTicketRepository;
        this.outboxRepository = outboxRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Create the order and write the outbox event in a single atomic transaction.
     *
     * <p>Called from {@link OrderService#createOrder} after the distributed lock is
     * acquired and the gRPC ticket validation has completed (both outside the TX to
     * avoid holding a DB connection during network I/O).
     *
     * @param userId    the authenticated user placing the order
     * @param ticketId  the ticket being purchased
     * @param grpcTicket validated ticket details from ticket-service
     * @return the created order as a response DTO
     * @throws BadRequestException if an active order already exists for this ticket
     */
    @Transactional
    public OrderResponse createOrderTransactional(UUID userId, UUID ticketId, ValidateTicketResponse grpcTicket) {
        // Guard: reject if an active order already exists for this ticket.
        // existsBy derived query avoids a JOIN FETCH — efficient EXISTS check (P-06).
        boolean alreadyReserved = orderRepository
                .existsByTicketIdAndStatusNotIn(ticketId, java.util.List.of(OrderStatus.CANCELLED, OrderStatus.COMPLETE));
        if (alreadyReserved) {
            throw new BadRequestException("Ticket is already reserved by another order");
        }

        // Upsert the local ticket replica from the authoritative gRPC response.
        // In normal production flow this row already exists (written by TicketEventConsumer
        // via Kafka). In local dev (Kafka disabled) or on first purchase after a cold start,
        // we create it here from the gRPC data so the order can proceed.
        OrderTicket ticket = orderTicketRepository.findById(ticketId).orElseGet(() -> {
            log.info("Local ticket replica not found; creating from gRPC response ticketId={}", ticketId);
            return orderTicketRepository.save(
                    new OrderTicket(ticketId, grpcTicket.getTitle(),
                            new java.math.BigDecimal(grpcTicket.getPrice()))
            );
        });

        OffsetDateTime expiresAt = OffsetDateTime.now().plusMinutes(expirationMinutes);
        Order order = new Order(userId, OrderStatus.CREATED, expiresAt, ticket);
        orderRepository.save(order);

        // Write outbox message in the same transaction — this is the invariant that
        // the transactional outbox pattern relies on. If either write fails, both
        // are rolled back and no phantom order or phantom event is created.
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

    private void writeOutbox(String topic, String partitionKey, Object payload) {
        try {
            String json = objectMapper.writeValueAsString(payload);
            outboxRepository.save(new OutboxMessage(topic, json, partitionKey));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialise outbox payload", e);
        }
    }
}
