package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Polls the outbox table every 500 ms and publishes unpublished messages to Kafka.
 *
 * Each outbox row is marked published within the same transaction as the Kafka send
 * is acknowledged. If the Kafka send fails the row remains unpublished and will be
 * retried on the next poll — guaranteeing at-least-once delivery.
 *
 * The partition key stored in the outbox is used as the Kafka message key so that
 * messages for the same entity (e.g. same orderId) land on the same partition,
 * preserving per-entity ordering (AGENTS.md §3.4).
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final OutboxRepository outboxRepository;
    private final KafkaTemplate<String, String> kafkaTemplate;

    public OutboxRelay(OutboxRepository outboxRepository,
                       KafkaTemplate<String, String> kafkaTemplate) {
        this.outboxRepository = outboxRepository;
        this.kafkaTemplate = kafkaTemplate;
    }

    @Scheduled(fixedDelay = 500)
    @Transactional
    public void relay() {
        List<OutboxMessage> pending = outboxRepository.findUnpublished();
        if (pending.isEmpty()) {
            return;
        }

        for (OutboxMessage msg : pending) {
            try {
                // send() is async — get() blocks until broker acknowledges (acks=all)
                kafkaTemplate.send(msg.getTopic(), msg.getPartitionKey(), msg.getPayload()).get();
                msg.markPublished();
                outboxRepository.save(msg);
                log.debug("Outbox message published id={} topic={}", msg.getId(), msg.getTopic());
            } catch (Exception e) {
                // Log and continue — the row stays unpublished and will be retried
                log.error("Failed to publish outbox message id={} topic={}: {}",
                        msg.getId(), msg.getTopic(), e.getMessage(), e);
            }
        }
    }
}
