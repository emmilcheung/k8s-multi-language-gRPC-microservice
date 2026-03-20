package com.ticketing.orders.kafka;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.service.OrderService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * Consumes payment-captured events from payment-service.
 *
 * When {@code payments.payment.captured} arrives this consumer marks the
 * corresponding order as COMPLETE via OrderService#markComplete.
 *
 * Idempotent: markComplete is a no-op if the order is already COMPLETE or
 * not in AWAITING_PAYMENT state.
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
    public void onPaymentCaptured(@Payload String message, Acknowledgment ack) {
        try {
            JsonNode root = objectMapper.readTree(message);
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
