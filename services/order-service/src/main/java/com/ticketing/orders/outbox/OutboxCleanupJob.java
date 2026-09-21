package com.ticketing.orders.outbox;

import com.ticketing.orders.repository.OutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

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
 * The delete is issued in batches of {@code outbox.cleanup.batch-size} rows, each
 * committing on its own so a failure part-way keeps the progress already made. At most
 * {@code outbox.cleanup.max-batches} batches run per invocation with the remainder
 * left to the next schedule.
 */
@Component
public class OutboxCleanupJob {

    private static final Logger log = LoggerFactory.getLogger(OutboxCleanupJob.class);

    /** Published rows older than this many hours are deleted. */
    private static final int RETENTION_HOURS = 24;

    private final OutboxRepository outboxRepository;
    private final int batchSize;
    private final int maxBatches;

    public OutboxCleanupJob(
            OutboxRepository outboxRepository,
            @Value("${outbox.cleanup.batch-size:500}") int batchSize,
            @Value("${outbox.cleanup.max-batches:100}") int maxBatches) {
        this.outboxRepository = outboxRepository;
        this.batchSize = batchSize;
        this.maxBatches = maxBatches;
    }

    @Scheduled(fixedDelay = 10 * 60 * 1000) // every 10 minutes
    public void purgePublished() {
        OffsetDateTime cutoff = OffsetDateTime.now().minusHours(RETENTION_HOURS);
        int total = 0;
        try {
            for (int batch = 0; batch < maxBatches; batch++) {
                int deleted = outboxRepository.deletePublishedBatch(cutoff, batchSize);
                total += deleted;
                if (deleted < batchSize) {
                    break;
                }
            }
            if (total > 0) {
                log.info("Outbox cleanup: deleted {} published rows older than {}h", total, RETENTION_HOURS);
            }
        } catch (Exception e) {
            log.warn("Outbox cleanup failed after {} rows — will retry on next schedule: {}",
                    total, e.getMessage(), e);
        }
    }
}
