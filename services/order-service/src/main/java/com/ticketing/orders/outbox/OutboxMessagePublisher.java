package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.kafka.KafkaTraceContext;
import com.ticketing.orders.repository.OutboxRepository;
import io.opentelemetry.context.Context;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.concurrent.TimeUnit;

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
    private final long publishTimeoutMs;

    public OutboxMessagePublisher(OutboxRepository outboxRepository,
                                  KafkaTemplate<String, String> kafkaTemplate,
                                  @Value("${outbox.relay.publish-timeout-ms:10000}") long publishTimeoutMs) {
        this.outboxRepository = outboxRepository;
        this.kafkaTemplate = kafkaTemplate;
        this.publishTimeoutMs = publishTimeoutMs;
    }

    /**
     * Sends {@code msg} to Kafka and, if the broker acknowledges (acks=all), marks it
     * published in the caller's transaction.
     *
     * <p>Returns {@code false} instead of throwing on a send failure. That is deliberate:
     * this method joins the relay's transaction (REQUIRED), so throwing would mark that
     * transaction rollback-only and discard the rows the batch had already published —
     * guaranteeing they are re-sent next poll. Returning a flag lets {@link OutboxRelay}
     * stop the batch and still commit the progress it made.</p>
     *
     * <p>Failure modes:</p>
     * <ul>
     *   <li>Kafka send fails or times out → logged, {@code false} returned; the row is never
     *       marked, so it stays unpublished and is retried on the next poll. The relay stops
     *       the batch there to preserve per-entity ordering (AGENTS.md §3.4).</li>
     *   <li>Send times out but the broker later accepts the record → the row is retried and
     *       the event is delivered twice. At-least-once is the outbox's contract; consumers
     *       must be idempotent (AGENTS.md §3.5).</li>
     *   <li>Kafka succeeds but the batch does not commit → the message was sent but the row
     *       is not marked published; it will be re-sent on the next poll. Consumers must
     *       be idempotent (AGENTS.md §3.5).</li>
     * </ul>
     *
     * @return true if the broker acknowledged the record and the row was marked published
     */
    @Transactional
    public boolean publishOne(OutboxMessage msg) {
        try {
            Context parentContext = KafkaTraceContext.extractContext(msg.getTraceHeaders());
            ProducerRecord<String, String> record =
                    new ProducerRecord<>(msg.getTopic(), msg.getPartitionKey(), msg.getPayload());
            // Restore the saved trace context; Spring Kafka observation injects it into Kafka headers
            try (io.opentelemetry.context.Scope ignored = parentContext.makeCurrent()) {
                // Bounded wait. An unbounded get() blocks until delivery.timeout.ms (~2 min by
                // default), and because the relay now holds a FOR UPDATE SKIP LOCKED claim for
                // the whole batch, that would pin every claimed row's lock for the duration.
                kafkaTemplate.send(record).get(publishTimeoutMs, TimeUnit.MILLISECONDS);
            }
            msg.markPublished();
            outboxRepository.save(msg);
            log.debug("Outbox message published id={} topic={}", msg.getId(), msg.getTopic());
            return true;
        } catch (InterruptedException e) {
            // Restore the flag so shutdown of the scheduler thread is not swallowed here.
            Thread.currentThread().interrupt();
            log.error("Interrupted publishing outbox message id={} topic={}",
                    msg.getId(), msg.getTopic(), e);
            return false;
        } catch (Exception e) {
            log.error("Failed to publish outbox message id={} topic={}: {}",
                    msg.getId(), msg.getTopic(), e.getMessage(), e);
            return false;
        }
    }
}
