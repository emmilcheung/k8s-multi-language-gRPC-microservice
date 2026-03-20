package com.ticketing.orders.controller;

import com.ticketing.orders.dto.CreateOrderRequest;
import com.ticketing.orders.dto.OrderResponse;
import com.ticketing.orders.service.OrderService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/**
 * REST controller for order lifecycle.
 *
 * Auth: Kong validates the JWT and injects X-User-Id into the request header.
 * This controller reads that header and passes the userId to the service layer.
 * It never re-validates the token (AGENTS.md §5.1).
 *
 * Routes:
 *   POST   /api/orders            — create order
 *   GET    /api/orders            — list user's orders
 *   GET    /api/orders/{id}       — get single order
 *   DELETE /api/orders/{id}       — cancel order
 */
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private static final String USER_ID_HEADER = "X-User-Id";

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    public ResponseEntity<OrderResponse> createOrder(
            @RequestHeader(USER_ID_HEADER) UUID userId,
            @Valid @RequestBody CreateOrderRequest request) {
        OrderResponse response = orderService.createOrder(userId, request);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    @GetMapping
    public ResponseEntity<List<OrderResponse>> listOrders(
            @RequestHeader(USER_ID_HEADER) UUID userId) {
        return ResponseEntity.ok(orderService.listOrders(userId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<OrderResponse> getOrder(
            @RequestHeader(USER_ID_HEADER) UUID userId,
            @PathVariable UUID id) {
        return ResponseEntity.ok(orderService.getOrder(id, userId));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<OrderResponse> cancelOrder(
            @RequestHeader(USER_ID_HEADER) UUID userId,
            @PathVariable UUID id) {
        return ResponseEntity.ok(orderService.cancelOrder(id, userId));
    }
}
