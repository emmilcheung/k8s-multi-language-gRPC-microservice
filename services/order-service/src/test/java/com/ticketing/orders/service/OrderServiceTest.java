package com.ticketing.orders.service;

import tools.jackson.databind.ObjectMapper;
import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.entity.OrderType;
import com.ticketing.orders.exception.BadRequestException;
import com.ticketing.orders.exception.ConflictException;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.exception.NotFoundException;
import com.ticketing.orders.grpc.AutoAssignAndReserveResponse;
import com.ticketing.orders.grpc.GetSeatingPlanResponse;
import com.ticketing.orders.grpc.ReserveHeldSeatsResponse;
import com.ticketing.orders.grpc.ReserveQuotaResponse;
import com.ticketing.orders.grpc.SeatDetail;
import com.ticketing.orders.grpc.TicketServiceClient;
import com.ticketing.orders.grpc.VenueServiceClient;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderSeatRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import com.ticketing.orders.repository.OutboxRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Unit tests for {@link OrderService} and {@link OrderTransactionService}.
 *
 * CP-05 rewrite: Redisson distributed lock removed. Order creation now uses
 * ReserveQuota gRPC call (GA reservation path). Tests verify:
 * - reserveQuota is called and order is saved on success
 * - compensation (releaseReservation) is called when the DB transaction fails
 * - gRPC errors propagate without compensation
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class OrderServiceTest {

    @Mock OrderRepository orderRepository;
    @Mock OrderSeatRepository orderSeatRepository;
    @Mock OrderTicketRepository orderTicketRepository;
    @Mock OutboxRepository outboxRepository;
    @Mock TicketServiceClient ticketServiceClient;
    @Mock VenueServiceClient venueServiceClient;

    // The two collaborating services — constructed manually so we can wire them together
    private OrderTransactionService orderTransactionService;
    private SeatedOrderTransactionService seatedOrderTransactionService;
    private OrderService orderService;

    private final UUID userId   = UUID.randomUUID();
    private final UUID ticketId = UUID.randomUUID();
    private final UUID orderId  = UUID.randomUUID();

    private OrderTicket ticket;

    @BeforeEach
    void setUp() {
        ObjectMapper objectMapper = new ObjectMapper();

        orderTransactionService = new OrderTransactionService(
                orderRepository, orderTicketRepository, outboxRepository, objectMapper);
        ReflectionTestUtils.setField(orderTransactionService, "expirationMinutes", 15);

        seatedOrderTransactionService = new SeatedOrderTransactionService(
                orderRepository, orderTicketRepository, orderSeatRepository, outboxRepository,
                objectMapper);
        ReflectionTestUtils.setField(seatedOrderTransactionService, "expirationMinutes", 15);

        orderService = new OrderService(
                orderRepository, orderSeatRepository, outboxRepository, ticketServiceClient,
                venueServiceClient, objectMapper, orderTransactionService,
                seatedOrderTransactionService);
        ReflectionTestUtils.setField(orderService, "expirationMinutes", 15);

        ticket = new OrderTicket(ticketId, "Concert Ticket", new BigDecimal("49.99"));

        // Default stub: no order_seats for any order (GA tests don't create them)
        when(orderSeatRepository.findAllByOrderId(any(UUID.class)))
                .thenReturn(Collections.emptyList());
    }

    /** Build a minimal {@link ReserveQuotaResponse} suitable for use in tests. */
    private ReserveQuotaResponse buildReserveResponse(UUID resId, int qty) {
        return ReserveQuotaResponse.newBuilder()
                .setSuccess(true)
                .setReservationId(resId.toString())
                .setTicketId(ticketId.toString())
                .setTitle(ticket.getTitle())
                .setPrice(ticket.getPrice().toPlainString())
                .setQuantity(qty)
                .setRemaining(9)
                .build();
    }

    // ── createOrder (full flow through OrderService + OrderTransactionService) ─

    @Test
    void createOrder_should_call_reserveQuota_and_save_order() {
        UUID reservationId = UUID.randomUUID();
        ReserveQuotaResponse reserveResponse = buildReserveResponse(reservationId, 1);

        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());

        when(ticketServiceClient.reserveQuota(
                eq(ticketId.toString()), any(UUID.class), eq(userId), eq(1), any(Instant.class)))
                .thenReturn(reserveResponse);
        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.of(ticket));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        OrderResponse response = orderService.createOrder(userId, req);

        verify(ticketServiceClient).reserveQuota(
                eq(ticketId.toString()), any(UUID.class), eq(userId), eq(1), any(Instant.class));
        verify(orderRepository).save(any(Order.class));
        verify(outboxRepository).save(any());
        assertThat(response.getStatus()).isEqualTo(OrderStatus.CREATED);
        assertThat(response.getUserId()).isEqualTo(userId);
        assertThat(response.getQuantity()).isEqualTo(1);
    }

    @Test
    void createOrder_should_compensate_when_db_transaction_fails() {
        UUID reservationId = UUID.randomUUID();
        ReserveQuotaResponse reserveResponse = buildReserveResponse(reservationId, 1);

        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());

        when(ticketServiceClient.reserveQuota(
                eq(ticketId.toString()), any(UUID.class), eq(userId), eq(1), any(Instant.class)))
                .thenReturn(reserveResponse);
        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.of(ticket));
        when(orderRepository.save(any(Order.class))).thenThrow(new RuntimeException("db write failed"));

        assertThatThrownBy(() -> orderService.createOrder(userId, req))
                .isInstanceOf(RuntimeException.class)
                .hasMessageContaining("db write failed");

        // Compensation: releaseReservation must be called with reason "COMPENSATION"
        verify(ticketServiceClient).releaseReservation(any(UUID.class), eq("COMPENSATION"));
    }

    @Test
    void createOrder_should_propagate_grpc_error_without_calling_compensation() {
        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());

        when(ticketServiceClient.reserveQuota(
                eq(ticketId.toString()), any(UUID.class), eq(userId), eq(1), any(Instant.class)))
                .thenThrow(new RuntimeException("grpc down"));

        assertThatThrownBy(() -> orderService.createOrder(userId, req))
                .isInstanceOf(RuntimeException.class)
                .hasMessageContaining("grpc down");

        // No reservation was made — no compensation needed
        verify(ticketServiceClient, never()).releaseReservation(any(UUID.class), anyString());
        verify(orderRepository, never()).save(any(Order.class));
    }

    @Test
    void createOrder_should_upsert_ticket_replica_from_grpc_when_local_replica_missing() {
        UUID reservationId = UUID.randomUUID();
        ReserveQuotaResponse reserveResponse = buildReserveResponse(reservationId, 1);

        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.empty());
        when(orderTicketRepository.save(any(OrderTicket.class))).thenAnswer(inv -> inv.getArgument(0));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        OrderResponse response = orderTransactionService.createOrderTransactional(
                userId, ticketId, reserveResponse, reservationId, 1);

        verify(orderTicketRepository).save(any(OrderTicket.class));
        verify(orderRepository).save(any(Order.class));
        assertThat(response.getStatus()).isEqualTo(OrderStatus.CREATED);
    }

    @Test
    void createOrder_should_persist_reservationId_and_quantity_on_order() {
        UUID reservationId = UUID.randomUUID();
        int quantity = 2;
        ReserveQuotaResponse reserveResponse = buildReserveResponse(reservationId, quantity);

        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.of(ticket));

        ArgumentCaptor<Order> orderCaptor = ArgumentCaptor.forClass(Order.class);
        when(orderRepository.save(orderCaptor.capture())).thenAnswer(inv -> inv.getArgument(0));

        orderTransactionService.createOrderTransactional(
                userId, ticketId, reserveResponse, reservationId, quantity);

        Order saved = orderCaptor.getValue();
        assertThat(saved.getReservationId()).isEqualTo(reservationId);
        assertThat(saved.getQuantity()).isEqualTo(quantity);
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
    void markComplete_should_set_COMPLETE_and_write_completed_outbox_event() {
        Order order = new Order(userId, OrderStatus.AWAITING_PAYMENT,
                OffsetDateTime.now().plusMinutes(5), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

        orderService.markComplete(orderId);

        assertThat(order.getStatus()).isEqualTo(OrderStatus.COMPLETE);
        // orders.order.completed must be written to the outbox
        verify(outboxRepository).save(any());
    }

    @Test
    void markComplete_should_be_noop_when_order_is_not_awaiting_payment() {
        Order order = new Order(userId, OrderStatus.CANCELLED,
                OffsetDateTime.now().minusMinutes(5), ticket);
        when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));

        orderService.markComplete(orderId);

        verify(outboxRepository, never()).save(any());
    }

        @Test
        void markPaymentFailed_should_cancel_payable_order_and_write_cancelled_outbox_event() {
                Order order = new Order(userId, OrderStatus.AWAITING_PAYMENT,
                                OffsetDateTime.now().plusMinutes(5), ticket);
                when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));
                when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));

                orderService.markPaymentFailed(orderId);

                assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
                verify(outboxRepository).save(any());
        }

        @Test
        void markPaymentFailed_should_be_noop_when_order_is_terminal() {
                Order order = new Order(userId, OrderStatus.COMPLETE,
                                OffsetDateTime.now().minusMinutes(5), ticket);
                when(orderRepository.findByIdWithTicket(orderId)).thenReturn(Optional.of(order));

                orderService.markPaymentFailed(orderId);

                verify(outboxRepository, never()).save(any());
        }

    // ── createSeatedOrder (MANUAL_SEATED) ─────────────────────────────────────

    /** Build a minimal {@link SeatDetail} suitable for use in tests. */
    private SeatDetail buildSeatDetail(UUID seatId, UUID sectionId, String label) {
        return SeatDetail.newBuilder()
                .setSeatId(seatId.toString())
                .setSectionId(sectionId.toString())
                .setSeatLabel(label)
                .setPrice(ticket.getPrice().toPlainString())
                .build();
    }

    @Test
    void createSeatedOrder_manual_should_reserve_held_seats_and_persist_order_with_seats() {
        UUID seatId    = UUID.randomUUID();
        UUID sectionId = UUID.randomUUID();
        UUID planId    = UUID.randomUUID();

        SeatDetail seatDetail = buildSeatDetail(seatId, sectionId, "A1");

        ReserveHeldSeatsResponse reserveResponse = ReserveHeldSeatsResponse.newBuilder()
                .setSuccess(true)
                .setReservationId(UUID.randomUUID().toString())
                .addSeats(seatDetail)
                .build();

        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());
        req.setPlanId(planId.toString());
        req.setSeatIds(List.of(seatId.toString()));
        req.setQuantity(1);

        GetSeatingPlanResponse planResponse = GetSeatingPlanResponse.newBuilder()
                .setAssignmentMode("manual")
                .build();
        when(venueServiceClient.getSeatingPlan(planId.toString())).thenReturn(planResponse);
        when(venueServiceClient.reserveHeldSeats(
                eq(planId.toString()), eq(ticketId.toString()), any(UUID.class),
                eq(userId), anyList(), any(Instant.class)))
                .thenReturn(reserveResponse);
        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.of(ticket));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));
        when(orderSeatRepository.saveAll(anyList())).thenAnswer(inv -> inv.getArgument(0));

        OrderResponse response = orderService.createSeatedOrder(userId, req);

        verify(venueServiceClient).reserveHeldSeats(
                eq(planId.toString()), eq(ticketId.toString()), any(UUID.class),
                eq(userId), anyList(), any(Instant.class));
        verify(orderRepository).save(any(Order.class));
        verify(orderSeatRepository).saveAll(anyList());
        verify(outboxRepository).save(any());
        assertThat(response.getStatus()).isEqualTo(OrderStatus.CREATED);
        assertThat(response.getOrderType()).isEqualTo(OrderType.MANUAL_SEATED);
        assertThat(response.getSeats()).hasSize(1);
    }

    @Test
    void createSeatedOrder_manual_should_throw_ConflictException_when_seats_unavailable() {
        UUID seatId = UUID.randomUUID();
        UUID planId = UUID.randomUUID();

        ReserveHeldSeatsResponse failResponse = ReserveHeldSeatsResponse.newBuilder()
                .setSuccess(false)
                .addUnavailableSeatIds(seatId.toString())
                .build();

        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());
        req.setPlanId(planId.toString());
        req.setSeatIds(List.of(seatId.toString()));
        req.setQuantity(1);

        GetSeatingPlanResponse planResponse = GetSeatingPlanResponse.newBuilder()
                .setAssignmentMode("manual")
                .build();
        when(venueServiceClient.getSeatingPlan(planId.toString())).thenReturn(planResponse);
        when(venueServiceClient.reserveHeldSeats(
                eq(planId.toString()), eq(ticketId.toString()), any(UUID.class),
                eq(userId), anyList(), any(Instant.class)))
                .thenReturn(failResponse);

        assertThatThrownBy(() -> orderService.createSeatedOrder(userId, req))
                .isInstanceOf(ConflictException.class)
                .hasMessageContaining("no longer available");

        verify(orderRepository, never()).save(any());
    }

    @Test
    void createSeatedOrder_manual_should_compensate_when_db_tx_fails() {
        UUID seatId    = UUID.randomUUID();
        UUID sectionId = UUID.randomUUID();
        UUID planId    = UUID.randomUUID();

        SeatDetail seatDetail = buildSeatDetail(seatId, sectionId, "B2");

        ReserveHeldSeatsResponse reserveResponse = ReserveHeldSeatsResponse.newBuilder()
                .setSuccess(true)
                .setReservationId(UUID.randomUUID().toString())
                .addSeats(seatDetail)
                .build();

        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());
        req.setPlanId(planId.toString());
        req.setSeatIds(List.of(seatId.toString()));
        req.setQuantity(1);

        GetSeatingPlanResponse planResponseCompensate = GetSeatingPlanResponse.newBuilder()
                .setAssignmentMode("manual")
                .build();
        when(venueServiceClient.getSeatingPlan(planId.toString())).thenReturn(planResponseCompensate);
        when(venueServiceClient.reserveHeldSeats(
                eq(planId.toString()), eq(ticketId.toString()), any(UUID.class),
                eq(userId), anyList(), any(Instant.class)))
                .thenReturn(reserveResponse);
        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.of(ticket));
        when(orderRepository.save(any(Order.class))).thenThrow(new RuntimeException("db exploded"));

        assertThatThrownBy(() -> orderService.createSeatedOrder(userId, req))
                .isInstanceOf(RuntimeException.class)
                .hasMessageContaining("db exploded");

        verify(venueServiceClient).releaseSeatReservation(any(UUID.class), eq("COMPENSATION"));
    }

    @Test
    void createSeatedOrder_autoAssign_should_call_autoAssignAndReserve_and_persist_order() {
        UUID seatId    = UUID.randomUUID();
        UUID sectionId = UUID.randomUUID();
        UUID planId    = UUID.randomUUID();

        SeatDetail seatDetail = buildSeatDetail(seatId, sectionId, "C3");

        AutoAssignAndReserveResponse assignResponse = AutoAssignAndReserveResponse.newBuilder()
                .setSuccess(true)
                .setReservationId(UUID.randomUUID().toString())
                .addSeats(seatDetail)
                .build();

        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId(ticketId.toString());
        req.setPlanId(planId.toString());
        req.setSectionId(sectionId.toString());
        req.setQuantity(1);

        GetSeatingPlanResponse planResponseAuto = GetSeatingPlanResponse.newBuilder()
                .setAssignmentMode("auto")
                .build();
        when(venueServiceClient.getSeatingPlan(planId.toString())).thenReturn(planResponseAuto);
        when(venueServiceClient.autoAssignAndReserve(
                eq(planId.toString()), eq(ticketId.toString()), eq(sectionId.toString()),
                any(UUID.class), eq(userId), eq(1), any(Instant.class)))
                .thenReturn(assignResponse);
        when(orderTicketRepository.findById(ticketId)).thenReturn(Optional.of(ticket));
        when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));
        when(orderSeatRepository.saveAll(anyList())).thenAnswer(inv -> inv.getArgument(0));

        OrderResponse response = orderService.createSeatedOrder(userId, req);

        verify(venueServiceClient).autoAssignAndReserve(
                eq(planId.toString()), eq(ticketId.toString()), eq(sectionId.toString()),
                any(UUID.class), eq(userId), eq(1), any(Instant.class));
        verify(orderRepository).save(any(Order.class));
        verify(orderSeatRepository).saveAll(anyList());
        verify(outboxRepository).save(any());
        assertThat(response.getStatus()).isEqualTo(OrderStatus.CREATED);
        assertThat(response.getOrderType()).isEqualTo(OrderType.AUTO_ASSIGN_SEATED);
        assertThat(response.getSeats()).hasSize(1);
    }
}
