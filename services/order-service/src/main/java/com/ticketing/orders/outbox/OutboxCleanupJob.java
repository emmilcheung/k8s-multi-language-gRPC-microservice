package com.ticketing.orders.outbox;

import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;

/**
 * Periodically purges old published outbox rows (R-14).
 *
 * Without cleanup the outbox table grows unboundedly. Rows that have been successfully
 * published to Kafka are no longer needed for at-least-once delivery; keeping them
 * longer than the retention window wastes storage and slows the relay query.
 *
 * Retention: 24 hours by default (safe for most replay / audit needs).
 * Frequency: every 10 minutes.
 *
 * The DELETE runs in its own transaction — if it fails it is logged at WARN
 * (not ERROR; the table is still functional) and retried on the next schedule.
 */
@Component
public class OutboxCleanupJob {

    private static final Logger log = LoggerFactory.getLogger(OutboxCleanupJob.class);

    /** Published rows older than this many hours are deleted. */
    private static final int RETENTION_HOURS = 24;

    private final OutboxRepository outboxRepository;

    public OutboxCleanupJob(OutboxRepository outboxRepository) {
        this.outboxRepository = outboxRepository;
    }

    @Scheduled(fixedDelay = 10 * 60 * 1000) // every 10 minutes
    @Transactional
    public void purgePublished() {
        OffsetDateTime cutoff = OffsetDateTime.now().minusHours(RETENTION_HOURS);
        try {
            int deleted = outboxRepository.deletePublishedBefore(cutoff);
            if (deleted > 0) {
                log.info("Outbox cleanup: deleted {} published rows older than {}h", deleted, RETENTION_HOURS);
            }
        } catch (Exception e) {
            log.warn("Outbox cleanup failed — will retry on next schedule: {}", e.getMessage(), e);
        }
    }
}
