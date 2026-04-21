package com.ticketing.orders.graphql;

import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.service.OrderService;
import org.springframework.graphql.data.method.annotation.Argument;
import org.springframework.graphql.data.method.annotation.MutationMapping;
import org.springframework.graphql.data.method.annotation.QueryMapping;
import org.springframework.graphql.data.method.annotation.SchemaMapping;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestHeader;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Controller
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @QueryMapping
    public OrderResponse order(
            @Argument String id,
            @RequestHeader("X-User-Id") String userId) {
        return orderService.getOrder(UUID.fromString(id), UUID.fromString(userId));
    }

    @QueryMapping
    public List<OrderResponse> orders(
            @RequestHeader("X-User-Id") String userId) {
        return orderService.listOrders(UUID.fromString(userId));
    }

    @MutationMapping
    public OrderResponse createOrder(
            @Argument Map<String, Object> input,
            @RequestHeader("X-User-Id") String userId) {
        CreateOrderRequest request = new CreateOrderRequest();
        request.setTicketId((String) input.get("ticketId"));
        request.setQuantity((Integer) input.getOrDefault("quantity", 1));
        return orderService.createOrder(UUID.fromString(userId), request);
    }

    @MutationMapping
    public OrderResponse cancelOrder(
            @Argument String id,
            @RequestHeader("X-User-Id") String userId) {
        return orderService.cancelOrder(UUID.fromString(id), UUID.fromString(userId));
    }

    @SchemaMapping(typeName = "User", field = "orders")
    public List<OrderResponse> userOrders(
            Map<String, Object> user,
            @RequestHeader("X-User-Id") String requesterId) {
        String userId = (String) user.get("id");
        if (!userId.equals(requesterId)) {
            return List.of();
        }
        return orderService.listOrders(UUID.fromString(userId));
    }
}
