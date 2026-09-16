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
 * Transactional helper that publishes a single outbox message to Kafka and marks it
 * published. {@code publishOne} keeps {@code @Transactional} with default REQUIRED
 * propagation, so it now joins the caller's transaction — {@link OutboxRelay#relay()}
 * claims the batch with {@code SELECT ... FOR UPDATE SKIP LOCKED} and holds that
 * transaction open across the loop, so the mark-published update for each message
 * commits together with the rest of the batch when {@code relay()} returns (SR-06 fix).
 *
 * Extracted from OutboxRelay so that Spring's @Transactional proxy applies correctly —
 * self-invocation within the same bean bypasses the proxy and does not start a new
 * transaction.
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
     * published. This method joins the caller's transaction (the relay's SKIP LOCKED
     * claim transaction) rather than starting its own, so the mark-published update
     * commits together with the rest of the batch when the caller's transaction commits.
     *
     * <p>Failure modes:</p>
     * <ul>
     *   <li>Kafka send fails → exception caught; row stays unpublished and will be
     *       retried on the next poll.</li>
     *   <li>Kafka succeeds but the batch's transaction later fails to commit → the
     *       message was sent but the row is not marked published; it will be re-sent
     *       on the next poll. Consumers must be idempotent (AGENTS.md §3.5).</li>
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
