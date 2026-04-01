package com.ticketing.orders.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.event.OrderCreatedEvent;
import com.ticketing.orders.grpc.ReserveQuotaResponse;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
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
 * CP-05: accepts {@code reservationId} and {@code quantity} from the GA reservation
 * response so they are persisted on the order and included in the outbox event.
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
     * <p>Called from {@link OrderService#createOrder} after ReserveQuota has succeeded
     * (outside the TX to avoid holding a DB connection during network I/O).
     *
     * <p>If this transaction fails, the caller is responsible for calling
     * ReleaseReservation as compensation.
     *
     * @param userId         the authenticated user placing the order
     * @param ticketId       the ticket being purchased
     * @param reserveResponse the gRPC ReserveQuota response (contains title, price, etc.)
     * @param reservationId  the UUID used as the idempotency key for ReserveQuota
     * @param quantity       number of units being purchased
     * @return the created order as a response DTO
     */
    @Transactional
    public OrderResponse createOrderTransactional(
            UUID userId, UUID ticketId, ReserveQuotaResponse reserveResponse,
            UUID reservationId, int quantity) {

        // Upsert the local ticket replica from the authoritative gRPC response.
        // In normal production flow this row already exists (written by TicketEventConsumer
        // via Kafka). In local dev (Kafka disabled) or on first purchase after a cold start,
        // we create it here from the gRPC data so the order can proceed.
        OrderTicket ticket = orderTicketRepository.findById(ticketId).orElseGet(() -> {
            log.info("Local ticket replica not found; creating from gRPC response ticketId={}", ticketId);
            return orderTicketRepository.save(
                    new OrderTicket(ticketId, reserveResponse.getTitle(),
                            new BigDecimal(reserveResponse.getPrice()))
            );
        });

        OffsetDateTime expiresAt = OffsetDateTime.now().plusMinutes(expirationMinutes);
        Order order = new Order(userId, OrderStatus.CREATED, expiresAt, ticket, reservationId, quantity);
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
                        reservationId.toString(),
                        quantity,
                        order.getVersion(),
                        null  // GA orders have no seat IDs (CP-12)
                ));

        log.info("Order created orderId={} userId={} ticketId={} reservationId={} quantity={}",
                order.getId(), userId, ticketId, reservationId, quantity);
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
