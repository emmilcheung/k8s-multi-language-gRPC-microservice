package com.ticketing.orders.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "orders")
public class Order {

    @Id
    @Column(nullable = false, updatable = false)
    private UUID id = UUID.randomUUID();

    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 30)
    private OrderStatus status;

    @Column(name = "expires_at", nullable = false)
    private OffsetDateTime expiresAt;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "ticket_id", nullable = false, updatable = false)
    private OrderTicket ticket;

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

    protected Order() {}

    public Order(UUID userId, OrderStatus status, OffsetDateTime expiresAt, OrderTicket ticket) {
        this.userId = userId;
        this.status = status;
        this.expiresAt = expiresAt;
        this.ticket = ticket;
    }

    // ── accessors ─────────────────────────────────────────────────────────────

    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public OrderStatus getStatus() { return status; }
    public void setStatus(OrderStatus status) { this.status = status; }
    public OffsetDateTime getExpiresAt() { return expiresAt; }
    public OrderTicket getTicket() { return ticket; }
    public int getVersion() { return version; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }

    /** True when this order is in a state that allows payment (CREATED or AWAITING_PAYMENT).
     *
     * AWAITING_PAYMENT is a UI display state; there is no production producer that
     * transitions orders into it before payment capture.  The real state machine is:
     *   CREATED → COMPLETE  (payment captured)
     *   CREATED → CANCELLED (expiration or user cancel)
     * Accepting CREATED here keeps this method consistent with the client's canPay
     * logic (order.status === "awaiting_payment" || order.status === "created").
     */
    public boolean isAwaitingPayment() {
        return this.status == OrderStatus.AWAITING_PAYMENT || this.status == OrderStatus.CREATED;
    }

    /** True when the order is in a terminal state. */
    public boolean isTerminal() {
        return this.status == OrderStatus.COMPLETE || this.status == OrderStatus.CANCELLED;
    }
}
