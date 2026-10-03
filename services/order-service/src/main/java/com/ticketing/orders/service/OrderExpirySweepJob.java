package com.ticketing.orders.service;

import com.ticketing.orders.repository.OrderRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Postgres backstop for order expiry.
 *
 * Normally an order expires when expiration-service's asynq job fires and publishes
 * {@code expiration.order.expiration_complete}. Asynq keeps its jobs in Redis, and
 * Redis replication is asynchronous, so a failover can drop jobs scheduled just
 * before it. Without a backstop those orders stay open forever and keep their seats
 * reserved. This job finds open orders more than {@code grace} past
 * {@code expires_at} and expires them through the same
 * {@link OrderService#expireOrder} the Kafka consumer calls.
 *
 * Safe on every replica without a leader lock. Each expireOrder is its own
 * transaction, and Order's {@code @Version} makes a concurrent expire — another
 * replica's sweep, the Kafka consumer, or a payment landing at the deadline — fail
 * with an optimistic lock error instead of emitting a second cancellation event. The
 * loser logs it and moves on; the order is no longer open, so no later sweep picks
 * it up.
 *
 * Deliberately not {@code @Transactional}: one bad order must not roll back the
 * others in the batch.
 */
@Component
public class OrderExpirySweepJob {

    private static final Logger log = LoggerFactory.getLogger(OrderExpirySweepJob.class);

    private final OrderRepository orderRepository;
    private final OrderService orderService;
    private final Duration grace;
    private final int batchSize;

    public OrderExpirySweepJob(
            OrderRepository orderRepository,
            OrderService orderService,
            @Value("${order.expiry-sweep.grace-seconds:300}") long graceSeconds,
            @Value("${order.expiry-sweep.batch-size:200}") int batchSize) {
        this.orderRepository = orderRepository;
        this.orderService = orderService;
        this.grace = Duration.ofSeconds(graceSeconds);
        this.batchSize = batchSize;
    }

    @Scheduled(fixedDelayString = "${order.expiry-sweep.interval-ms:60000}")
    public void sweep() {
        List<UUID> overdue;
        try {
            overdue = orderRepository.findOverdueOpenOrderIds(OffsetDateTime.now().minus(grace), batchSize);
        } catch (Exception e) {
            log.warn("Order expiry sweep query failed — will retry on next schedule: {}", e.getMessage(), e);
            return;
        }

        int expired = 0;
        for (UUID orderId : overdue) {
            try {
                orderService.expireOrder(orderId);
                expired++;
            } catch (Exception e) {
                log.warn("Order expiry sweep could not expire orderId={} — will retry on next schedule: {}",
                        orderId, e.getMessage());
            }
        }
        if (expired > 0) {
            // WARN, not INFO: every order found here is one the asynq path missed.
            log.warn("Order expiry sweep expired {} orders more than {}s overdue that expiration-service never expired",
                    expired, grace.toSeconds());
        }
    }
}
