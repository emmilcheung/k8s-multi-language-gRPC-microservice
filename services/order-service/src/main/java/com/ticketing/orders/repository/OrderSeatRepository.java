package com.ticketing.orders.repository;

import com.ticketing.orders.entity.OrderSeat;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface OrderSeatRepository extends JpaRepository<OrderSeat, UUID> {
    List<OrderSeat> findAllByOrderId(UUID orderId);
}
