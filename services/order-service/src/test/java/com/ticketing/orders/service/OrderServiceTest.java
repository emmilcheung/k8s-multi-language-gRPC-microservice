package com.ticketing.orders.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.exception.BadRequestException;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.exception.NotFoundException;
import com.ticketing.orders.grpc.TicketServiceClient;
import com.ticketing.orders.grpc.ValidateTicketResponse;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    @Mock OrderRepository orderRepository;
    @Mock OrderTicketRepository orderTicketRepository;
    @Mock OutboxRepository outboxRepository;
    @Mock TicketServiceClient ticketServiceClient;

    @InjectMocks OrderService orderService;

    private final UUID userId   = UUID.randomUUID();
    private final UUID ticketId = UUID.randomUUID();
    private final UUID orderId  = UUID.randomUUID();

    private OrderTicket ticket;

    @BeforeEach
    void setUp() {
        // Inject real ObjectMapper so serialisation works in unit tests
        ReflectionTestUtils.setField(orderService, "objectMapper", new ObjectMapper()
                .findAndRegisterModules());
        // Set expiration to 15 minutes
        ReflectionTestUtils.setField(orderService, "expirationMinutes", 15);

        ticket = new OrderTicket(ticketId, "Concert Ticket", new BigDecimal("49.99"));
    }

    // ── createOrder ───────────────────────────────────────────────────────────

    @Test
    void createOrder_should_save_order_and_outbox_when_ticket_available() {
        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());

        // No active order for this ticket
        when(orderRepository.findActiveByTicketId(eq(ticketId), anyList()))
                .thenReturn(Optional.empty());
        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.of(ticket));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        OrderResponse response = orderService.createOrder(userId, req);

        verify(ticketServiceClient).validateAvailability(ticketId.toString());
        verify(orderRepository).save(any(Order.class));
        verify(outboxRepository).save(any());
        assertThat(response.getStatus()).isEqualTo(OrderStatus.CREATED);
        assertThat(response.getUserId()).isEqualTo(userId);
    }

    @Test
    void createOrder_should_throw_BadRequestException_when_ticket_already_reserved() {
        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());

        Order existing = new Order(UUID.randomUUID(), OrderStatus.CREATED,
                OffsetDateTime.now().plusMinutes(15), ticket);
        when(orderRepository.findActiveByTicketId(eq(ticketId), anyList()))
                .thenReturn(Optional.of(existing));

        // grpcTicket is null because the "already reserved" guard throws before it is used
        assertThatThrownBy(() -> orderService.createOrderTransactional(userId, ticketId, null))
                .isInstanceOf(BadRequestException.class)
                .hasMessageContaining("already reserved");

        verify(orderRepository, never()).save(any(Order.class));
    }

    @Test
    void createOrder_should_upsert_ticket_replica_from_grpc_when_local_replica_missing() {
        // When Kafka is disabled (local dev) or delivery is delayed, the local replica may
        // not exist yet. The service should upsert it from the authoritative gRPC response.
        when(orderRepository.findActiveByTicketId(eq(ticketId), anyList()))
                .thenReturn(Optional.empty());
        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.empty());
        when(orderTicketRepository.save(any(OrderTicket.class))).thenAnswer(inv -> inv.getArgument(0));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        // Build a minimal ValidateTicketResponse stub using the protobuf builder
        ValidateTicketResponse grpcTicket = ValidateTicketResponse.newBuilder()
                .setAvailable(true)
                .setTicketId(ticketId.toString())
                .setTitle("Concert Ticket")
                .setPrice(49.99f)
                .build();

        OrderResponse response = orderService.createOrderTransactional(userId, ticketId, grpcTicket);

        verify(orderTicketRepository).save(any(OrderTicket.class));
        verify(orderRepository).save(any(Order.class));
        assertThat(response.getStatus()).isEqualTo(OrderStatus.CREATED);
    }

    // ── getOrder ──────────────────────────────────────────────────────────────

    @Test
    void getOrder_should_return_order_when_user_is_owner() {
        Order order = new Order(userId, OrderStatus.CREATED,
                OffsetDateTime.now().plusMinutes(15), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));

        OrderResponse response = orderService.getOrder(orderId, userId);

        assertThat(response.getUserId()).isEqualTo(userId);
    }

    @Test
    void getOrder_should_throw_ForbiddenException_when_user_is_not_owner() {
        UUID anotherUser = UUID.randomUUID();
        Order order = new Order(anotherUser, OrderStatus.CREATED,
                OffsetDateTime.now().plusMinutes(15), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));

        assertThatThrownBy(() -> orderService.getOrder(orderId, userId))
                .isInstanceOf(ForbiddenException.class);
    }

    @Test
    void getOrder_should_throw_NotFoundException_when_order_not_found() {
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> orderService.getOrder(orderId, userId))
                .isInstanceOf(NotFoundException.class);
    }

    // ── cancelOrder ───────────────────────────────────────────────────────────

    @Test
    void cancelOrder_should_set_status_to_CANCELLED_and_write_outbox() {
        Order order = new Order(userId, OrderStatus.CREATED,
                OffsetDateTime.now().plusMinutes(15), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        OrderResponse response = orderService.cancelOrder(orderId, userId);

        assertThat(response.getStatus()).isEqualTo(OrderStatus.CANCELLED);
        verify(outboxRepository).save(any());
    }

    @Test
    void cancelOrder_should_throw_BadRequestException_when_order_is_already_terminal() {
        Order order = new Order(userId, OrderStatus.COMPLETE,
                OffsetDateTime.now().minusMinutes(1), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));

        assertThatThrownBy(() -> orderService.cancelOrder(orderId, userId))
                .isInstanceOf(BadRequestException.class)
                .hasMessageContaining("terminal state");
    }

    @Test
    void cancelOrder_should_throw_ForbiddenException_when_user_is_not_owner() {
        UUID anotherUser = UUID.randomUUID();
        Order order = new Order(anotherUser, OrderStatus.CREATED,
                OffsetDateTime.now().plusMinutes(15), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));

        assertThatThrownBy(() -> orderService.cancelOrder(orderId, userId))
                .isInstanceOf(ForbiddenException.class);
    }

    // ── listOrders ────────────────────────────────────────────────────────────

    @Test
    void listOrders_should_return_all_orders_for_user() {
        Order o1 = new Order(userId, OrderStatus.CREATED,
                OffsetDateTime.now().plusMinutes(15), ticket);
        Order o2 = new Order(userId, OrderStatus.COMPLETE,
                OffsetDateTime.now().minusMinutes(5), ticket);
        when(orderRepository.findAllByUserIdWithTicket(userId)).thenReturn(List.of(o1, o2));

        List<OrderResponse> responses = orderService.listOrders(userId);

        assertThat(responses).hasSize(2);
    }

    // ── expireOrder ───────────────────────────────────────────────────────────

    @Test
    void expireOrder_should_cancel_active_order_and_write_outbox() {
        Order order = new Order(userId, OrderStatus.AWAITING_PAYMENT,
                OffsetDateTime.now().minusMinutes(1), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        orderService.expireOrder(orderId);

        verify(outboxRepository).save(any());
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
    }

    @Test
    void expireOrder_should_be_noop_when_order_is_already_terminal() {
        Order order = new Order(userId, OrderStatus.COMPLETE,
                OffsetDateTime.now().minusMinutes(5), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));

        orderService.expireOrder(orderId);

        verify(outboxRepository, never()).save(any());
    }

    // ── markComplete ──────────────────────────────────────────────────────────

    @Test
    void markComplete_should_set_COMPLETE_when_order_awaiting_payment() {
        Order order = new Order(userId, OrderStatus.AWAITING_PAYMENT,
                OffsetDateTime.now().plusMinutes(5), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        orderService.markComplete(orderId);

        assertThat(order.getStatus()).isEqualTo(OrderStatus.COMPLETE);
    }
}
