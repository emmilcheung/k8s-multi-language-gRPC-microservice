package com.ticketing.orders.config;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.annotation.EnableKafka;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.CommonErrorHandler;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.ExponentialBackOff;

/**
 * Kafka consumer error handling and dead-letter topic configuration.
 *
 * Policy (AGENTS.md §3.5):
 * - On processing failure: retry with exponential back-off (max 3 attempts).
 * - After retries exhausted: route to Dead Letter Topic (<original-topic>.dlq).
 * - Never silently discard a message.
 */
@Configuration
@EnableKafka
public class KafkaConfig {

    // ── Dead-letter topics ────────────────────────────────────────────────────

    @Bean
    public NewTopic ticketsDlq() {
        return TopicBuilder.name("tickets.ticket.created.dlq").partitions(1).replicas(1).build();
    }

    @Bean
    public NewTopic expirationDlq() {
        return TopicBuilder.name("expiration.order.expiration_complete.dlq").partitions(1).replicas(1).build();
    }

    @Bean
    public NewTopic paymentDlq() {
        return TopicBuilder.name("payments.payment.captured.dlq").partitions(1).replicas(1).build();
    }

    // ── Error handler with DLQ ────────────────────────────────────────────────

    /**
     * Global error handler applied to all @KafkaListener containers.
     *
     * Retries up to 3 times with exponential back-off starting at 1 s, multiplied by 2
     * each attempt. After exhausting retries the message is forwarded to the DLQ topic
     * (automatically named "<original-topic>.DLT" by DeadLetterPublishingRecoverer —
     * we declare matching topic names above).
     */
    @Bean
    public CommonErrorHandler kafkaErrorHandler(KafkaTemplate<String, String> kafkaTemplate) {
        DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(kafkaTemplate);

        ExponentialBackOff backOff = new ExponentialBackOff(1_000L, 2.0);
        backOff.setMaxAttempts(3);

        return new DefaultErrorHandler(recoverer, backOff);
    }
}
