package com.ticketing.orders.kafka;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.service.OrderService;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * Consumes expiration events from expiration-service.
 *
 * When expiration-service fires {@code expiration.order.expiration_complete},
 * this consumer cancels the corresponding order (if it hasn't already been
 * completed or manually cancelled) and emits an {@code orders.order.cancelled}
 * outbox event via OrderService#expireOrder.
 *
 * Idempotent: expireOrder is a no-op if the order is already in a terminal state.
 */
@Component
public class ExpirationEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(ExpirationEventConsumer.class);

    private final OrderService orderService;
    private final ObjectMapper objectMapper;

    public ExpirationEventConsumer(OrderService orderService, ObjectMapper objectMapper) {
        this.orderService = orderService;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(
            topics = "expiration.order.expiration_complete",
            groupId = "order-service",
            containerFactory = "kafkaListenerContainerFactory"
    )
    public void onExpirationComplete(ConsumerRecord<String, String> record, Acknowledgment ack) {
        Context parentContext = KafkaTraceContext.extractContext(record);
        Span span = GlobalOpenTelemetry.getTracer("order-service")
                .spanBuilder("kafka consume " + record.topic())
                .setParent(parentContext)
                .setSpanKind(SpanKind.CONSUMER)
                .startSpan();
        try {
            try (Scope ignored = span.makeCurrent()) {
                JsonNode root = objectMapper.readTree(record.value());
                JsonNode data = root.path("data");
                UUID orderId = UUID.fromString(data.path("orderId").asText());

                orderService.expireOrder(orderId);
                log.info("Processed expiration event orderId={}", orderId);
                ack.acknowledge();
            }
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            log.error("Failed to process expiration event: {}", e.getMessage(), e);
            throw new RuntimeException("Expiration event processing failed", e);
        } finally {
            span.end();
        }
    }
}
