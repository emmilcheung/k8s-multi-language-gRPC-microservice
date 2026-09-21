package com.ticketing.orders.repository;

import com.ticketing.orders.entity.OutboxMessage;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.QueryHints;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

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
     * Deletes at most {@code batchSize} published outbox rows older than the given
     * timestamp, oldest first. Called in a loop by
     * {@link com.ticketing.orders.outbox.OutboxCleanupJob}.
     *
     * <p>{@code @Transactional} sits on this repository method and NOT on the calling
     * job, so each batch commits on its own. That is the point of the change: a single
     * unbounded DELETE over a backlog holds row locks and pins the vacuum horizon for
     * the whole run, and on timeout makes no progress at all, so the next run retries
     * the same doomed statement.
     *
     * <p>Backed by the partial index {@code idx_outbox_published_created ON
     * outbox(created_at) WHERE published = true} (V6). V1's partial index covers only
     * {@code published = false}, which is the relay's claim query, not this one.
     */
    @Modifying
    @Transactional
    @Query(value = "DELETE FROM outbox WHERE id IN ("
                 + "SELECT id FROM outbox WHERE published = true AND created_at < :before "
                 + "ORDER BY created_at ASC LIMIT :batchSize)",
           nativeQuery = true)
    int deletePublishedBatch(@Param("before") OffsetDateTime before, @Param("batchSize") int batchSize);
}
