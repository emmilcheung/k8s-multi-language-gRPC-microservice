package com.ticketing.orders.service;

import com.ticketing.orders.dto.OrderResponse;

/** Outcome of an order create; {@code replayed} is true when an Idempotency-Key matched an existing order. */
public record CreateOrderResult(OrderResponse order, boolean replayed) {}
