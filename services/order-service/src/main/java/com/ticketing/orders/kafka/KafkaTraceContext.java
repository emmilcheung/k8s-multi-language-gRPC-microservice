package com.ticketing.orders.kafka;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Utilities for W3C trace-context propagation through the transactional outbox pattern.
 *
 * <p>Consumer-side context extraction (from ConsumerRecord headers) is handled natively
 * by Spring Kafka observation (listener.observation-enabled: true) and is not needed here.
 *
 * <p>Only two operations remain:
 * <ul>
 *   <li>{@link #captureCurrentTraceHeaders()} — called by the service layer at write-time
 *       to capture the active trace context into the outbox row.</li>
 *   <li>{@link #extractContext(Map)} — called by {@link com.ticketing.orders.outbox.OutboxMessagePublisher}
 *       at publish-time to restore the saved context before sending to Kafka.</li>
 * </ul>
 */
public final class KafkaTraceContext {

    private static final TextMapSetter<Map<String, String>> MAP_SETTER = Map::put;

    private static final TextMapGetter<Map<String, String>> MAP_GETTER = new TextMapGetter<>() {
        @Override
        public Iterable<String> keys(Map<String, String> carrier) {
            return carrier.keySet();
        }

        @Override
        public String get(Map<String, String> carrier, String key) {
            return carrier.get(key);
        }
    };

    private KafkaTraceContext() {
    }

    /** Captures the current W3C trace context headers for storage in the outbox row. */
    public static Map<String, String> captureCurrentTraceHeaders() {
        Map<String, String> carrier = new LinkedHashMap<>();
        GlobalOpenTelemetry.getPropagators().getTextMapPropagator()
                .inject(Context.current(), carrier, MAP_SETTER);
        return carrier;
    }

    /** Restores a W3C trace context from headers previously captured by {@link #captureCurrentTraceHeaders()}. */
    public static Context extractContext(Map<String, String> headers) {
        Map<String, String> safeHeaders = headers == null ? Map.of() : headers;
        return GlobalOpenTelemetry.getPropagators().getTextMapPropagator()
                .extract(Context.current(), safeHeaders, MAP_GETTER);
    }
}
