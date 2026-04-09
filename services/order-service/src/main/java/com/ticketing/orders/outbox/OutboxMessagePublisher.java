package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.kafka.KafkaTraceContext;
import com.ticketing.orders.repository.OutboxRepository;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Transactional helper that publishes a single outbox message to Kafka and marks it
 * published in its own Spring-managed DB transaction (C-02 fix).
 *
 * Extracted from OutboxRelay so that Spring's @Transactional proxy applies correctly —
 * self-invocation within the same bean bypasses the proxy and does not start a new
 * transaction.
 */
@Component
public class OutboxMessagePublisher {

    private static final Logger log = LoggerFactory.getLogger(OutboxMessagePublisher.class);
    private static final Tracer TRACER = GlobalOpenTelemetry.getTracer("order-service");

    private final OutboxRepository outboxRepository;
    private final KafkaTemplate<String, String> kafkaTemplate;

    public OutboxMessagePublisher(OutboxRepository outboxRepository,
                                  KafkaTemplate<String, String> kafkaTemplate) {
        this.outboxRepository = outboxRepository;
        this.kafkaTemplate = kafkaTemplate;
    }

    /**
     * Sends {@code msg} to Kafka and, if the broker acknowledges (acks=all), commits
     * the mark-published update in its own transaction.
     *
     * <p>Failure modes:</p>
     * <ul>
     *   <li>Kafka send fails → exception caught; DB transaction is never entered; row
     *       stays unpublished and will be retried on the next poll.</li>
     *   <li>Kafka succeeds but DB commit fails → the message was sent but the row is
     *       not marked published; it will be re-sent on the next poll. Consumers must
     *       be idempotent (AGENTS.md §3.5).</li>
     * </ul>
     */
    @Transactional
    public void publishOne(OutboxMessage msg) {
        Context parentContext = KafkaTraceContext.extractContext(msg.getTraceHeaders());
        Span span = TRACER.spanBuilder("kafka publish " + msg.getTopic())
                .setParent(parentContext)
                .setSpanKind(SpanKind.PRODUCER)
                .startSpan();
        try {
            ProducerRecord<String, String> record =
                    new ProducerRecord<>(msg.getTopic(), msg.getPartitionKey(), msg.getPayload());
            try (Scope ignored = span.makeCurrent()) {
                KafkaTraceContext.injectContext(Context.current(), record.headers());
                kafkaTemplate.send(record).get();
            }
            msg.markPublished();
            outboxRepository.save(msg);
            log.debug("Outbox message published id={} topic={}", msg.getId(), msg.getTopic());
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            log.error("Failed to publish outbox message id={} topic={}: {}",
                    msg.getId(), msg.getTopic(), e.getMessage(), e);
        } finally {
            span.end();
        }
    }
}
