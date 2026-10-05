package com.ticketing.orders.repository;

import com.ticketing.orders.entity.Order;
import com.ticketing.orders.entity.OrderStatus;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
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
     * Like {@link #findByIdWithTicket} but row-locks the order until the transaction
     * ends, so an expiry or cancel can't commit while payment capture is deciding
     * the order's outcome.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT o FROM Order o JOIN FETCH o.ticket WHERE o.id = :id")
    Optional<Order> findByIdWithTicketForUpdate(UUID id);

    /**
     * idempotent-retry lookup. reservation_id is derived from (userId, key), so the
     * user check is defence in depth; uq_orders_reservation_id makes the result unique.
     */
    @Query("SELECT o FROM Order o JOIN FETCH o.ticket WHERE o.reservationId = :reservationId AND o.userId = :userId")
    Optional<Order> findByReservationIdAndUserId(UUID reservationId, UUID userId);

    /**
     * Returns true if an active (non-cancelled, non-complete) order exists for the given ticket.
     * Derived query — no JOIN FETCH needed; Spring Data generates an efficient EXISTS query (P-06).
     */
    boolean existsByTicketIdAndStatusNotIn(UUID ticketId, List<OrderStatus> excludedStatuses);

    /**
     * Returns the ids of open (CREATED / AWAITING_PAYMENT) orders that are due for
     * expiry, oldest first, at most {@code limit} of them.
     *
     * <p>A CREATED order is due once it expired before {@code cutoff} (the sweep grace
     * that lets the normal expiry path win). An AWAITING_PAYMENT order is due once it
     * expired before {@code paymentCutoff}: expireOrder leaves it open until the
     * payment grace after expiry has passed, so asking earlier would only be deferred.
     * The payment grace is the shorter one, so AWAITING_PAYMENT orders are picked up
     * sooner, which is intended since venue releases the seats a minute after expiry.
     * Native query so the status literals match V7's partial index predicate.
     */
    @Query(value = "SELECT id FROM orders"
            + " WHERE status IN ('CREATED', 'AWAITING_PAYMENT') AND expires_at < :paymentCutoff"
            + " AND (status = 'AWAITING_PAYMENT' OR expires_at < :cutoff)"
            + " ORDER BY expires_at LIMIT :limit", nativeQuery = true)
    List<UUID> findOverdueOpenOrderIds(OffsetDateTime cutoff, OffsetDateTime paymentCutoff, int limit);
}
