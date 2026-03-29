package com.ticketing.orders.repository;

import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface OrderRepository extends JpaRepository<Order, UUID> {

    @Query("SELECT o FROM Order o JOIN FETCH o.ticket WHERE o.userId = :userId")
    List<Order> findAllByUserIdWithTicket(UUID userId);

    @Query("SELECT o FROM Order o JOIN FETCH o.ticket WHERE o.id = :id")
    Optional<Order> findByIdWithTicket(UUID id);

    /**
     * Returns true if an active (non-cancelled, non-complete) order exists for the given ticket.
     * Derived query — no JOIN FETCH needed; Spring Data generates an efficient EXISTS query (P-06).
     */
    boolean existsByTicketIdAndStatusNotIn(UUID ticketId, List<OrderStatus> excludedStatuses);
}
