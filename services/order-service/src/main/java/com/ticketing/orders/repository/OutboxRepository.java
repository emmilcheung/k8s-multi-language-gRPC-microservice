package com.ticketing.orders.repository;

import com.ticketing.orders.entity.OutboxMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Repository
public interface OutboxRepository extends JpaRepository<OutboxMessage, UUID> {

    @Query(value = "SELECT * FROM outbox WHERE published = false "
                 + "ORDER BY created_at ASC LIMIT :limit FOR UPDATE SKIP LOCKED",
           nativeQuery = true)
    List<OutboxMessage> findUnpublishedForUpdate(@Param("limit") int limit);

    /**
     * Deletes published outbox rows older than the given timestamp.
     * Called by {@link com.ticketing.orders.outbox.OutboxCleanupJob} on a schedule.
     */
    @Modifying
    @Query("DELETE FROM OutboxMessage o WHERE o.published = true AND o.createdAt < :before")
    int deletePublishedBefore(OffsetDateTime before);
}
