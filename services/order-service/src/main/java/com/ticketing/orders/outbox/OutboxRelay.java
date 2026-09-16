package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
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
 * Each {@code relay()} run claims a bounded batch of rows in a single transaction via
 * {@link OutboxRepository#findUnpublishedForUpdate} (native {@code SELECT ... FOR UPDATE
 * SKIP LOCKED}), so concurrent relay replicas (HPA scale-out) each claim disjoint row
 * sets and never double-publish the same row. The claim transaction stays open across
 * the whole publish loop — each message is still published via
 * {@link OutboxMessagePublisher#publishOne}, but that method now joins this transaction
 * instead of opening its own, so the mark-published updates commit together with the
 * batch when {@code relay()} returns (SR-06 fix).
 *
 * If the Kafka send fails for a row, the exception is caught and logged internally; that
 * row stays unpublished and will be retried on the next poll. When {@code relay()} returns,
 * only successfully published rows are marked published. Consumers must be idempotent
 * (AGENTS.md §3.5) because a message can be sent to Kafka but fail to be marked published
 * if the batch transaction itself fails to commit.
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
                       @Value("${outbox.relay.batch-size:100}") int batchSize) {
        this.outboxRepository = outboxRepository;
        this.publisher = publisher;
        this.batchSize = batchSize;
    }

    @Scheduled(fixedDelayString = "${outbox.relay.poll-interval-ms:5000}")
    @Transactional
    public void relay() {
        List<OutboxMessage> pending = outboxRepository.findUnpublishedForUpdate(batchSize);
        if (pending.isEmpty()) {
            return;
        }

        for (OutboxMessage msg : pending) {
            publisher.publishOne(msg);
        }
    }
}
