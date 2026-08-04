package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Pageable;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Polls the outbox table at a configurable interval and publishes unpublished messages to Kafka.
 * Default poll interval is 5 000 ms — override via OUTBOX_RELAY_POLL_INTERVAL_MS env var.
 * Reducing from 500 ms to 5 000 ms cuts DB queries and OTel spans ~10× while keeping
 * end-to-end event latency well within the 15-minute order expiry window.
 *
 * Each poll claims a bounded page (default 50, OUTBOX_RELAY_BATCH_SIZE) rather than the whole
 * unpublished backlog, so a Kafka outage cannot turn the backlog into an OOM.
 *
 * The claim uses FOR UPDATE SKIP LOCKED, which only isolates replicas for as long as the
 * claiming transaction lives — hence {@code @Transactional} on this method. That supersedes
 * the earlier per-message-transaction arrangement (C-02): with 2–8 replicas, per-message
 * commits meant every replica published every row on every poll, which is a far larger
 * correctness problem than the batch commit this reintroduces. Batch scope is bounded by the
 * page size.
 *
 * Failure handling is unchanged where it matters: {@link OutboxMessagePublisher#publishOne}
 * still swallows a failed Kafka send, so one unreachable partition does not stop the rest of
 * the page, and the unmarked row is retried next poll. A DB failure while marking, by
 * contrast, now marks the batch rollback-only, so the whole page is re-published — bounded by
 * the page size, and consumers must be idempotent regardless (AGENTS.md §3.5).
 *
 * The partition key stored in the outbox is used as the Kafka message key so that
 * messages for the same entity (e.g. same orderId) land on the same partition,
 * preserving per-entity ordering (AGENTS.md §3.4).
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final OutboxRepository outboxRepository;
    private final OutboxMessagePublisher publisher;
    private final int batchSize;

    public OutboxRelay(OutboxRepository outboxRepository,
                       OutboxMessagePublisher publisher,
                       @Value("${outbox.relay.batch-size:50}") int batchSize) {
        this.outboxRepository = outboxRepository;
        this.publisher = publisher;
        this.batchSize = batchSize;
    }

    @Scheduled(fixedDelayString = "${outbox.relay.poll-interval-ms:5000}")
    @Transactional
    public void relay() {
        List<OutboxMessage> pending = outboxRepository.findUnpublished(Pageable.ofSize(batchSize));
        if (pending.isEmpty()) {
            return;
        }

        for (OutboxMessage msg : pending) {
            publisher.publishOne(msg);
        }
    }
}
