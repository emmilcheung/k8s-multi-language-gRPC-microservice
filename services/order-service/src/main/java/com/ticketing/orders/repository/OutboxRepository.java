package com.ticketing.orders.repository;

import com.ticketing.orders.entity.OutboxMessage;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.QueryHints;
import org.springframework.stereotype.Repository;

import jakarta.persistence.QueryHint;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

@Repository
public interface OutboxRepository extends JpaRepository<OutboxMessage, UUID> {

    /**
     * Claims at most {@code pageable.getPageSize()} unpublished messages, oldest first.
     *
     * <p><b>Bounded.</b> The unbounded form loaded the entire unpublished backlog into the
     * heap on every poll, so a Kafka outage turned a growing backlog into an OOM — the one
     * failure mode the outbox exists to survive. The page size caps heap use per poll; the
     * remainder is picked up on the next tick.</p>
     *
     * <p><b>Claimed.</b> {@code FOR UPDATE SKIP LOCKED} — Hibernate's {@code SKIP_LOCKED}
     * lock timeout of -2 — makes concurrent replicas claim disjoint rows. This service runs
     * 2 replicas and scales to 8 under HPA (infra/helm/charts/order-service/values.yaml), so
     * without it every replica publishes every row on every poll. The lock lives for the
     * caller's transaction, so the caller must claim <i>and</i> publish inside one
     * transaction — see {@link com.ticketing.orders.outbox.OutboxRelay#relay()}.</p>
     *
     * <p>Backed by the partial index {@code idx_outbox_unpublished ON outbox(created_at)
     * WHERE published = false} (V1__init.sql), so claim cost tracks backlog depth rather
     * than table size.</p>
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
    @Query("SELECT o FROM OutboxMessage o WHERE o.published = false ORDER BY o.createdAt ASC")
    List<OutboxMessage> findUnpublished(Pageable pageable);

    /**
     * Deletes published outbox rows older than the given timestamp.
     * Called by {@link com.ticketing.orders.outbox.OutboxCleanupJob} on a schedule.
     */
    @Modifying
    @Query("DELETE FROM OutboxMessage o WHERE o.published = true AND o.createdAt < :before")
    int deletePublishedBefore(OffsetDateTime before);
}
