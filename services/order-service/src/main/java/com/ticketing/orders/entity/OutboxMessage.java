package com.ticketing.orders.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Outbox record — written in the same DB transaction as the order state change.
 * The OutboxRelay publishes these to Kafka and marks them published.
 */
@Entity
@Table(name = "outbox")
public class OutboxMessage {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(nullable = false)
    private String topic;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "partition_key", nullable = false)
    private String partitionKey;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "trace_headers", nullable = false, columnDefinition = "jsonb")
    private Map<String, String> traceHeaders = new HashMap<>();

    @Column(nullable = false)
    private boolean published = false;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @PrePersist
    void prePersist() {
        this.createdAt = OffsetDateTime.now();
    }

    // ── constructors ───────────────────────────────────────────────────────────

    protected OutboxMessage() {}

    public OutboxMessage(String topic, String payload, String partitionKey) {
        this(topic, payload, partitionKey, Map.of());
    }

    public OutboxMessage(String topic, String payload, String partitionKey, Map<String, String> traceHeaders) {
        this.topic = topic;
        this.payload = payload;
        this.partitionKey = partitionKey;
        this.traceHeaders = traceHeaders == null ? new HashMap<>() : new HashMap<>(traceHeaders);
    }

    // ── accessors ─────────────────────────────────────────────────────────────

    public UUID getId() { return id; }
    public String getTopic() { return topic; }
    public String getPayload() { return payload; }
    public String getPartitionKey() { return partitionKey; }
    public Map<String, String> getTraceHeaders() { return traceHeaders; }
    public boolean isPublished() { return published; }
    public void markPublished() { this.published = true; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
}
