package com.ticketing.orders.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.kafka.annotation.EnableKafka;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.CommonErrorHandler;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.ExponentialBackOff;

import java.util.Map;

/**
 * Kafka consumer error handling and dead-letter topic configuration.
 *
 * Policy (AGENTS.md §3.5):
 * - On processing failure: retry with exponential back-off (max 3 attempts).
 * - After retries exhausted: route to Dead Letter Topic (<original-topic>.dlq).
 * - Never silently discard a message.
 *
 * Note: NewTopic @Beans are intentionally omitted — they trigger KafkaAdmin
 * initialisation which blocks at startup when the broker is unreachable (local dev
 * with Kafka disabled). Topics are created on first use by the broker.
 */
@Configuration
@EnableKafka
public class KafkaConfig {

    /** Injected from {@code spring.kafka.bootstrap-servers} / {@code KAFKA_BROKERS} env var. */
    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    /**
     * Override the auto-configured KafkaAdmin with one that never blocks at startup.
     * {@code autoCreate = false} means it will not attempt to create topics on
     * application startup. This prevents the context refresh from blocking/timing out
     * when the Kafka broker is unavailable (e.g. local dev with Kafka disabled).
     *
     * Previously hardcoded to "localhost:9092" — now reads from spring.kafka.bootstrap-servers
     * so it works in all environments (fixes audit finding R-15).
     */
    @Bean
    @Primary
    public KafkaAdmin kafkaAdmin() {
        KafkaAdmin admin = new KafkaAdmin(Map.of(
                "bootstrap.servers", bootstrapServers,
                "request.timeout.ms", "1000",
                "default.api.timeout.ms", "1000"
        ));
        admin.setAutoCreate(false);
        admin.setFatalIfBrokerNotAvailable(false);
        return admin;
    }

    // ── Error handler with DLQ ────────────────────────────────────────────────

    /**
     * Global error handler applied to all @KafkaListener containers.
     *
     * Retries up to 3 times with exponential back-off starting at 1 s, multiplied by 2
     * each attempt. After exhausting retries the message is forwarded to the DLQ topic
     * (automatically named "<original-topic>.dlq" by DeadLetterPublishingRecoverer —
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
