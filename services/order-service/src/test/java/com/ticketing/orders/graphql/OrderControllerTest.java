package com.ticketing.orders.graphql;

import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.exception.ForbiddenException;
import com.ticketing.orders.service.OrderService;
import graphql.GraphQLContext;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
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
}
