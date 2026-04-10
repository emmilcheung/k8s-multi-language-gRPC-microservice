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
 * Consumes expiration events from expiration-service.
 *
 * When expiration-service fires {@code expiration.order.expiration_complete},
 * this consumer cancels the corresponding order (if it hasn't already been
 * completed or manually cancelled) and emits an {@code orders.order.cancelled}
 * outbox event via OrderService#expireOrder.
 *
 * Idempotent: expireOrder is a no-op if the order is already in a terminal state.
 * Tracing: Spring Kafka observation (observation-enabled: true) auto-creates a
 * CONSUMER span and propagates the W3C trace context from Kafka headers.
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
        try {
            JsonNode root = objectMapper.readTree(record.value());
            JsonNode data = root.path("data");
            UUID orderId = UUID.fromString(data.path("orderId").asText());

            orderService.expireOrder(orderId);
            log.info("Processed expiration event orderId={}", orderId);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process expiration event: {}", e.getMessage(), e);
            throw new RuntimeException("Expiration event processing failed", e);
        }
    }
}
