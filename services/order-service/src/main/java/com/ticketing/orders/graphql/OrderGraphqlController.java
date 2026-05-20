package com.ticketing.orders.graphql;

import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.service.OrderService;
import graphql.GraphQLContext;
import org.springframework.graphql.data.method.annotation.Argument;
import org.springframework.graphql.data.method.annotation.MutationMapping;
import org.springframework.graphql.data.method.annotation.QueryMapping;
import org.springframework.graphql.data.method.annotation.SchemaMapping;
import org.springframework.stereotype.Controller;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Controller("orderGraphqlController")
public class OrderGraphqlController {

    private final OrderService orderService;

    public OrderGraphqlController(OrderService orderService) {
        this.orderService = orderService;
    }

    @QueryMapping
    public OrderResponse order(
            @Argument String id,
            GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        if (userId == null) return null;
        return orderService.getOrder(UUID.fromString(id), UUID.fromString(userId));
    }

    @QueryMapping
    public List<OrderResponse> orders(GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        if (userId == null) return List.of();
        return orderService.listOrders(UUID.fromString(userId));
    }

    @MutationMapping
    public OrderResponse createOrder(
            @Argument Map<String, Object> input,
            GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        if (userId == null) return null;
        CreateOrderRequest req = new CreateOrderRequest();
        req.setTicketId((String) input.get("ticketId"));
        req.setQuantity((Integer) input.getOrDefault("quantity", 1));
        return orderService.createOrder(UUID.fromString(userId), req);
    }

    @MutationMapping
    public OrderResponse cancelOrder(
            @Argument String id,
            GraphQLContext ctx) {
        String userId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        if (userId == null) return null;
        return orderService.cancelOrder(UUID.fromString(id), UUID.fromString(userId));
    }

    @SchemaMapping(typeName = "Order", field = "payment")
    public Map<String, Object> payment(OrderResponse order, GraphQLContext ctx) {
        String requesterId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        if (requesterId == null || order == null || order.getUserId() == null || order.getId() == null) {
            return null;
        }
        if (!order.getUserId().toString().equals(requesterId)) {
            return null;
        }
        return Map.of(
                "__typename", "Payment",
                "orderId", order.getId().toString()
        );
    }

    @SchemaMapping(typeName = "User", field = "orders")
    public List<OrderResponse> userOrders(
            Map<String, Object> user,
            GraphQLContext ctx) {
        String requesterId = ctx.get(UserIdInterceptor.USER_ID_KEY);
        String userId = (String) user.get("id");
        if (requesterId == null || !userId.equals(requesterId)) {
            return List.of();
        }
        return orderService.listOrders(UUID.fromString(userId));
    }
}
