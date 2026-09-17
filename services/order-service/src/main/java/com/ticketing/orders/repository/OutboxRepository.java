package com.ticketing.orders.repository;

import com.ticketing.orders.entity.OutboxMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

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
     * Deletes at most {@code batchSize} published outbox rows older than the given
     * timestamp, oldest first. Called in a loop by
     * {@link com.ticketing.orders.outbox.OutboxCleanupJob}.
     *
     * <p>{@code @Transactional} sits on this repository method and NOT on the calling
     * job, so each batch commits on its own. That is the point of the change: a single
     * unbounded DELETE over a backlog holds row locks and pins the vacuum horizon for
     * the whole run, and on timeout makes no progress at all, so the next run retries
     * the same doomed statement.
     */
    @Modifying
    @Transactional
    @Query(value = "DELETE FROM outbox WHERE id IN ("
                 + "SELECT id FROM outbox WHERE published = true AND created_at < :before "
                 + "ORDER BY created_at ASC LIMIT :batchSize)",
           nativeQuery = true)
    int deletePublishedBatch(@Param("before") OffsetDateTime before, @Param("batchSize") int batchSize);
}
