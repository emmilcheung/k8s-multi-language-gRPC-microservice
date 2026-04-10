package com.ticketing.orders.kafka;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.ticketing.orders.service.OrderService;
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
 * Tracing: Spring Kafka observation (observation-enabled: true) auto-creates a
 * CONSUMER span and propagates the W3C trace context from Kafka headers.
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
        try {
            JsonNode root = objectMapper.readTree(record.value());
            JsonNode data = root.path("data");
            UUID orderId = UUID.fromString(data.path("orderId").asText());

            orderService.markComplete(orderId);
            log.info("Processed payment captured event orderId={}", orderId);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process payment captured event: {}", e.getMessage(), e);
            throw new RuntimeException("Payment event processing failed", e);
        }
    }
}
