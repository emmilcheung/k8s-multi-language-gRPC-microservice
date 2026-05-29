package com.ticketing.orders.graphql;

import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.dto.RefundEligibilityResponse;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.service.OrderService;
import graphql.GraphQLContext;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class OrderControllerTest {

    @Mock
    private OrderService orderService;

    private OrderGraphqlController controller;

    @BeforeEach
    void setUp() {
        controller = new OrderGraphqlController(orderService);
    }

    private GraphQLContext ctxWithUserId(String userId) {
        return GraphQLContext.newContext()
                .of(UserIdInterceptor.USER_ID_KEY, userId)
                .build();
    }

    @Test
    void orders_returnsList() {
        String userId = UUID.randomUUID().toString();
        OrderResponse order = new OrderResponse();
        when(orderService.listOrders(UUID.fromString(userId))).thenReturn(List.of(order));

        List<OrderResponse> result = controller.orders(ctxWithUserId(userId));

        assertThat(result).containsExactly(order);
        verify(orderService).listOrders(UUID.fromString(userId));
    }

    @Test
    void order_returnsOrder() {
        String userId = UUID.randomUUID().toString();
        String orderId = UUID.randomUUID().toString();
        OrderResponse order = new OrderResponse();
        when(orderService.getOrder(UUID.fromString(orderId), UUID.fromString(userId))).thenReturn(order);

        OrderResponse result = controller.order(orderId, ctxWithUserId(userId));

        assertThat(result).isSameAs(order);
    }

    @Test
    void order_throwsForbiddenWhenNotOwner() {
        String userId = UUID.randomUUID().toString();
        String orderId = UUID.randomUUID().toString();
        when(orderService.getOrder(UUID.fromString(orderId), UUID.fromString(userId)))
                .thenThrow(new ForbiddenException("You do not own this order"));

        assertThatThrownBy(() -> controller.order(orderId, ctxWithUserId(userId)))
                .isInstanceOf(ForbiddenException.class);
    }

    @Test
    void refundEligibility_returnsEligibilityForOwner() {
        String userId = UUID.randomUUID().toString();
        String orderId = UUID.randomUUID().toString();
        RefundEligibilityResponse eligibility = new RefundEligibilityResponse(
                UUID.fromString(orderId),
                true,
                null,
                4200,
                "2027-01-01T10:00:00Z"
        );
        when(orderService.refundEligibility(UUID.fromString(orderId), UUID.fromString(userId)))
                .thenReturn(eligibility);

        RefundEligibilityResponse result = controller.refundEligibility(orderId, ctxWithUserId(userId));

        assertThat(result).isSameAs(eligibility);
        verify(orderService).refundEligibility(UUID.fromString(orderId), UUID.fromString(userId));
    }

    @Test
    void refundEligibility_returnsNullWhenRequesterMissing() {
        String orderId = UUID.randomUUID().toString();

        RefundEligibilityResponse result = controller.refundEligibility(orderId, GraphQLContext.newContext().build());

        assertThat(result).isNull();
        verify(orderService, never()).refundEligibility(any(), any());
    }

    @Test
    void userOrders_returnsSelfOrders() {
        String userId = UUID.randomUUID().toString();
        OrderResponse order = new OrderResponse();
        when(orderService.listOrders(UUID.fromString(userId))).thenReturn(List.of(order));

        java.util.Map<String, Object> userRef = java.util.Map.of("id", userId);
        List<OrderResponse> result = controller.userOrders(userRef, ctxWithUserId(userId));

        assertThat(result).containsExactly(order);
    }

    @Test
    void userOrders_returnsEmptyForOtherUser() {
        String userId = UUID.randomUUID().toString();
        String requesterId = UUID.randomUUID().toString();

        java.util.Map<String, Object> userRef = java.util.Map.of("id", userId);
        List<OrderResponse> result = controller.userOrders(userRef, ctxWithUserId(requesterId));

        assertThat(result).isEmpty();
    }

    @Test
    void payment_returnsFederatedReferenceForOwner() {
        String userId = UUID.randomUUID().toString();
        OrderResponse order = new OrderResponse();
        ReflectionTestUtils.setField(order, "id", UUID.fromString("11111111-1111-1111-1111-111111111111"));
        ReflectionTestUtils.setField(order, "userId", UUID.fromString(userId));

        Map<String, Object> result = controller.payment(order, ctxWithUserId(userId));

        assertThat(result).containsEntry("__typename", "Payment");
        assertThat(result).containsEntry("orderId", "11111111-1111-1111-1111-111111111111");
    }

    @Test
    void payment_returnsNullForOtherUser() {
        String userId = UUID.randomUUID().toString();
        OrderResponse order = new OrderResponse();
        ReflectionTestUtils.setField(order, "id", UUID.randomUUID());
        ReflectionTestUtils.setField(order, "userId", UUID.fromString(userId));

        Map<String, Object> result = controller.payment(order, ctxWithUserId(UUID.randomUUID().toString()));

        assertThat(result).isNull();
    }

    @Test
    void createSeatedOrder_withAttendeeInvalidUuidSeatId_throwsIllegalArgumentException() {
        String userId = UUID.randomUUID().toString();
        when(orderService.createSeatedOrder(eq(UUID.fromString(userId)), any(CreateOrderRequest.class)))
                .thenAnswer(invocation -> {
                    CreateOrderRequest req = invocation.getArgument(1);
                    req.validate();
                    return null;
                });

        Map<String, Object> attendeeWithInvalidSeatId = Map.of(
                "seatId", "not-a-uuid",
                "name", "John Doe"
        );
        Map<String, Object> input = Map.of(
                "ticketId", UUID.randomUUID().toString(),
                "quantity", 1,
                "planId", UUID.randomUUID().toString(),
                "attendees", List.of(attendeeWithInvalidSeatId)
        );

        assertThatThrownBy(() -> controller.createSeatedOrder(input, ctxWithUserId(userId)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("attendee[0].seatId")
                .hasMessageContaining("valid UUID");
    }
}
