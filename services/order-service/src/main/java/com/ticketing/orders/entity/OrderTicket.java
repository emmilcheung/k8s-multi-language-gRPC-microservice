package com.ticketing.orders.entity;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * Local replica of ticket data — consumed from Kafka (tickets.ticket.created / updated).
 * Order-service never queries ticket-service's database directly (AGENTS.md §0 rule 3).
 */
@Entity
@Table(name = "order_tickets")
public class OrderTicket {

    @Id
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal price;

    @Version
    @Column(nullable = false)
    private int version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    @PrePersist
    void prePersist() {
        OffsetDateTime now = OffsetDateTime.now();
        this.createdAt = now;
        this.updatedAt = now;
    }

    @PreUpdate
    void preUpdate() {
        this.updatedAt = OffsetDateTime.now();
    }

    // ── constructors ───────────────────────────────────────────────────────────

    protected OrderTicket() {}

    public OrderTicket(UUID id, String title, BigDecimal price) {
        this.id = id;
        this.title = title;
        this.price = price;
    }

    // ── accessors ─────────────────────────────────────────────────────────────

    public UUID getId() { return id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public BigDecimal getPrice() { return price; }
    public void setPrice(BigDecimal price) { this.price = price; }
    public int getVersion() { return version; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }
}
