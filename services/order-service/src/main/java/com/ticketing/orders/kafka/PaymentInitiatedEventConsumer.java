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
 * Consumes payment-initiated events from payment-service.
 *
 * When {@code payments.payment.initiated} arrives this consumer marks the
 * corresponding order as AWAITING_PAYMENT via OrderService#markAwaitingPayment.
 *
 * This event is emitted when a payment is first created (PaymentIntent initiated),
 * allowing the order to transition from CREATED to AWAITING_PAYMENT.
 *
 * Idempotent: markAwaitingPayment is a no-op if the order is not in CREATED state
 * or is already terminal.
 * Tracing: Spring Kafka observation (observation-enabled: true) auto-creates a
 * CONSUMER span and propagates the W3C trace context from Kafka headers.
 */
@Component
public class PaymentInitiatedEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(PaymentInitiatedEventConsumer.class);

    private final OrderService orderService;
    private final ObjectMapper objectMapper;

    public PaymentInitiatedEventConsumer(OrderService orderService, ObjectMapper objectMapper) {
        this.orderService = orderService;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(
            topics = "payments.payment.initiated",
            groupId = "order-service",
            containerFactory = "kafkaListenerContainerFactory"
    )
    public void onPaymentInitiated(ConsumerRecord<String, String> record, Acknowledgment ack) {
        try {
            JsonNode root = objectMapper.readTree(record.value());
            JsonNode data = root.path("data");
            UUID orderId = UUID.fromString(data.path("orderId").asText());

            orderService.markAwaitingPayment(orderId);
            log.info("Processed payment initiated event orderId={}", orderId);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed to process payment initiated event: {}", e.getMessage(), e);
            throw new RuntimeException("Payment initiated event processing failed", e);
        }
    }
}
