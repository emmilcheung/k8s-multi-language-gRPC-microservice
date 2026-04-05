package com.ticketing.orders.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "order_seats")
public class OrderSeat {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "order_id", nullable = false, updatable = false)
    private UUID orderId;

    @Column(name = "seat_id", nullable = false, updatable = false)
    private UUID seatId;

    @Column(name = "section_id", nullable = false, updatable = false)
    private UUID sectionId;

    @Column(name = "seat_label", nullable = false, updatable = false)
    private String seatLabel;

    @Column(nullable = false, precision = 12, scale = 2, updatable = false)
    private BigDecimal price;

    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private OffsetDateTime createdAt;

    @PrePersist
    void prePersist() {
        if (this.createdAt == null) {
            this.createdAt = OffsetDateTime.now();
        }
    }

    // ── constructors ───────────────────────────────────────────────────────────

    protected OrderSeat() {}

    public OrderSeat(UUID orderId, UUID seatId, UUID sectionId, String seatLabel, BigDecimal price) {
        this.orderId = orderId;
        this.seatId = seatId;
        this.sectionId = sectionId;
        this.seatLabel = seatLabel;
        this.price = price;
    }

    // ── accessors ─────────────────────────────────────────────────────────────

    public UUID getId() { return id; }
    public UUID getOrderId() { return orderId; }
    public UUID getSeatId() { return seatId; }
    public UUID getSectionId() { return sectionId; }
    public String getSeatLabel() { return seatLabel; }
    public BigDecimal getPrice() { return price; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
}
