package com.ticketing.orders.repository;

import com.ticketing.orders.entity.OrderTicket;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.UUID;

@Repository
public interface OrderTicketRepository extends JpaRepository<OrderTicket, UUID> {
}
