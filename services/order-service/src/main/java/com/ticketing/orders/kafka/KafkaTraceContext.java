package com.ticketing.orders.kafka;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapSetter;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.Headers;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

public final class KafkaTraceContext {

    private static final TextMapGetter<ConsumerRecord<String, String>> CONSUMER_RECORD_GETTER =
            new TextMapGetter<>() {
                @Override
                public Iterable<String> keys(ConsumerRecord<String, String> carrier) {
                    return Arrays.stream(carrier.headers().toArray()).map(Header::key).toList();
                }

                @Override
                public String get(ConsumerRecord<String, String> carrier, String key) {
                    Header header = carrier.headers().lastHeader(key);
                    if (header == null || header.value() == null) {
                        return null;
                    }
                    return new String(header.value(), StandardCharsets.UTF_8);
                }
            };

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

    private static final TextMapSetter<Map<String, String>> MAP_SETTER = Map::put;

    private static final TextMapSetter<Headers> HEADERS_SETTER = (headers, key, value) -> {
        headers.remove(key);
        headers.add(key, value.getBytes(StandardCharsets.UTF_8));
    };

    private KafkaTraceContext() {
    }

    public static Map<String, String> captureCurrentTraceHeaders() {
        Map<String, String> carrier = new LinkedHashMap<>();
        GlobalOpenTelemetry.getPropagators().getTextMapPropagator()
                .inject(Context.current(), carrier, MAP_SETTER);
        return carrier;
    }

    public static Context extractContext(ConsumerRecord<String, String> record) {
        return GlobalOpenTelemetry.getPropagators().getTextMapPropagator()
                .extract(Context.current(), record, CONSUMER_RECORD_GETTER);
    }

    public static Context extractContext(Map<String, String> headers) {
        Map<String, String> safeHeaders = headers == null ? Map.of() : headers;
        return GlobalOpenTelemetry.getPropagators().getTextMapPropagator()
                .extract(Context.current(), safeHeaders, MAP_GETTER);
    }

    public static void injectContext(Context context, Headers headers) {
        GlobalOpenTelemetry.getPropagators().getTextMapPropagator()
                .inject(context, headers, HEADERS_SETTER);
    }
}