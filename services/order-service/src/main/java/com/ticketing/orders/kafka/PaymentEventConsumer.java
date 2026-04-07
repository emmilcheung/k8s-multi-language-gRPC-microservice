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
 * Consumes payment-captured events from payment-service.
 *
 * When {@code payments.payment.captured} arrives this consumer marks the
 * corresponding order as COMPLETE via OrderService#markComplete.
 *
 * Idempotent: markComplete is a no-op if the order is already COMPLETE or
 * in a state that does not allow payment (CANCELLED or already COMPLETE).
 */
@Component
public class PaymentEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(PaymentEventConsumer.class);

    private final OrderService orderService;
    private final ObjectMapper objectMapper;

    public PaymentEventConsumer(OrderService orderService, ObjectMapper objectMapper) {
        this.orderService = orderService;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(
            topics = "payments.payment.captured",
            groupId = "order-service",
            containerFactory = "kafkaListenerContainerFactory"
    )
    public void onPaymentCaptured(ConsumerRecord<String, String> record, Acknowledgment ack) {
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

                orderService.markComplete(orderId);
                log.info("Processed payment captured event orderId={}", orderId);
                ack.acknowledge();
            }
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            log.error("Failed to process payment captured event: {}", e.getMessage(), e);
            throw new RuntimeException("Payment event processing failed", e);
        } finally {
            span.end();
        }
    }
}
