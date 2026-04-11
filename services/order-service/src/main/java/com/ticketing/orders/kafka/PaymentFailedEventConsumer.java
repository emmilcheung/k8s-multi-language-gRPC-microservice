package com.ticketing.orders.kafka;

import com.ticketing.orders.service.OrderService;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.UUID;

/**
 * Consumes failed-payment events from payment-service.
 *
 * When {@code payments.payment.failed} arrives this consumer cancels the
 * corresponding order via OrderService#markPaymentFailed.
 */
@Component
public class PaymentFailedEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(PaymentFailedEventConsumer.class);

    private final OrderService orderService;
    private final ObjectMapper objectMapper;

    public PaymentFailedEventConsumer(OrderService orderService, ObjectMapper objectMapper) {
        this.orderService = orderService;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(
            topics = "payments.payment.failed",
            groupId = "order-service",
            containerFactory = "kafkaListenerContainerFactory"
    )
    public void onPaymentFailed(ConsumerRecord<String, String> record, Acknowledgment ack) {
        try {
            JsonNode root = objectMapper.readTree(record.value());
            JsonNode data = root.path("data");
            UUID orderId = UUID.fromString(data.path("orderId").asText());

            orderService.markPaymentFailed(orderId);
            log.info("Processed payment failed event orderId={}", orderId);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process payment failed event: {}", e.getMessage(), e);
            throw new RuntimeException("Payment failed event processing failed", e);
        }
    }
}