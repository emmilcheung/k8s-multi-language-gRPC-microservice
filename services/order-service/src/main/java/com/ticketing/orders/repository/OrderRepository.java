package com.ticketing.orders.repository;

import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
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

    /**
     * Returns the ids of open (CREATED / AWAITING_PAYMENT) orders that expired
     * before {@code cutoff}, oldest first, at most {@code limit} of them (SR-16).
     * Native query so the status literals match V7's partial index predicate.
     */
    @Query(value = "SELECT id FROM orders"
            + " WHERE status IN ('CREATED', 'AWAITING_PAYMENT') AND expires_at < :cutoff"
            + " ORDER BY expires_at LIMIT :limit", nativeQuery = true)
    List<UUID> findOverdueOpenOrderIds(OffsetDateTime cutoff, int limit);
}
