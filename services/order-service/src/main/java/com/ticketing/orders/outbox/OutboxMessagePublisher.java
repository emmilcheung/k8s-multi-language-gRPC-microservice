package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.kafka.KafkaTraceContext;
import com.ticketing.orders.repository.OutboxRepository;
import io.opentelemetry.context.Context;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Transactional helper that publishes a single outbox message to Kafka and marks it published.
 *
 * Called from {@link OutboxRelay#relay()}, which is itself @Transactional so the
 * FOR UPDATE SKIP LOCKED claim survives the publish loop; REQUIRED propagation means this
 * joins that batch transaction rather than opening one per message. Kept as a separate bean
 * because self-invocation within OutboxRelay would bypass Spring's proxy entirely.
 *
 * Tracing: restores the saved W3C trace context before calling kafkaTemplate.send() so
 * that Spring Kafka observation (template.observation-enabled: true) injects it into
 * Kafka message headers, preserving the trace through the outbox pattern.
 */
@Component
public class OutboxMessagePublisher {

    private static final Logger log = LoggerFactory.getLogger(OutboxMessagePublisher.class);

    private final OutboxRepository outboxRepository;
    private final KafkaTemplate<String, String> kafkaTemplate;

    public OutboxMessagePublisher(OutboxRepository outboxRepository,
                                  KafkaTemplate<String, String> kafkaTemplate) {
        this.outboxRepository = outboxRepository;
        this.kafkaTemplate = kafkaTemplate;
    }

    /**
     * Sends {@code msg} to Kafka and, if the broker acknowledges (acks=all), marks it
     * published in the caller's transaction.
     *
     * <p>Failure modes:</p>
     * <ul>
     *   <li>Kafka send fails → exception caught and logged; the row is never marked, so it
     *       stays unpublished and is retried on the next poll. The rest of the batch
     *       continues.</li>
     *   <li>Kafka succeeds but the batch does not commit → the message was sent but the row
     *       is not marked published; it will be re-sent on the next poll. Consumers must
     *       be idempotent (AGENTS.md §3.5).</li>
     * </ul>
     */
    @Transactional
    public void publishOne(OutboxMessage msg) {
        try {
            Context parentContext = KafkaTraceContext.extractContext(msg.getTraceHeaders());
            ProducerRecord<String, String> record =
                    new ProducerRecord<>(msg.getTopic(), msg.getPartitionKey(), msg.getPayload());
            // Restore the saved trace context; Spring Kafka observation injects it into Kafka headers
            try (io.opentelemetry.context.Scope ignored = parentContext.makeCurrent()) {
                kafkaTemplate.send(record).get();
            }
            msg.markPublished();
            outboxRepository.save(msg);
            log.debug("Outbox message published id={} topic={}", msg.getId(), msg.getTopic());
        } catch (Exception e) {
            log.error("Failed to publish outbox message id={} topic={}: {}",
                    msg.getId(), msg.getTopic(), e.getMessage(), e);
        }
    }
}
