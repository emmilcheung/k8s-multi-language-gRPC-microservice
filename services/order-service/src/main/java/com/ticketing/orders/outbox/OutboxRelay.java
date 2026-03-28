package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Polls the outbox table every 500 ms and publishes unpublished messages to Kafka.
 *
 * Each message is published via {@link OutboxMessagePublisher#publishOne}, which runs
 * in its own Spring-managed transaction. This ensures the mark-published DB update is
 * committed atomically per message, not per batch (C-02 fix).
 *
 * If the Kafka send fails the DB update is never reached, so the row stays unpublished
 * and will be retried. If the DB commit fails after a successful Kafka send, the message
 * will be re-sent on the next poll — consumers must be idempotent (AGENTS.md §3.5).
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

    public OutboxRelay(OutboxRepository outboxRepository,
                       OutboxMessagePublisher publisher) {
        this.outboxRepository = outboxRepository;
        this.publisher = publisher;
    }

    @Scheduled(fixedDelay = 500)
    public void relay() {
        List<OutboxMessage> pending = outboxRepository.findUnpublished();
        if (pending.isEmpty()) {
            return;
        }

        for (OutboxMessage msg : pending) {
            publisher.publishOne(msg);
        }
    }
}
