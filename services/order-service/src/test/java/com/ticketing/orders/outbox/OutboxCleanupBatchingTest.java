package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.AdditionalAnswers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration;
import org.springframework.boot.hibernate.autoconfigure.HibernateJpaAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.transaction.autoconfigure.TransactionAutoConfiguration;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import javax.sql.DataSource;
import java.time.OffsetDateTime;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

/**
 * Proves that batched cleanup deletes published rows in bounded chunks, with each
 * batch committing on its own so failures part-way keep the progress already made.
 *
 * <p>The cleanup job originally issued one unbounded DELETE in a single transaction.
 * Over a backlog (millions of publishable rows after a broker outage) that holds row
 * locks and pins the vacuum horizon for the entire run. On timeout it makes zero
 * progress, so the next run retries the exact same doomed statement forever.
 *
 * <p>This test suite validates the batched solution: each batch is bounded by
 * {@code outbox.cleanup.batch-size}, runs in its own transaction, and a failure
 * mid-run leaves all committed batches' deletions intact.
 *
 * <p>Runs against a real PostgreSQL via Testcontainers.
 */
@SpringBootTest(
        classes = OutboxCleanupBatchingTest.MinimalJpaSliceConfig.class,
        webEnvironment = SpringBootTest.WebEnvironment.NONE)
@ActiveProfiles("test")
@Testcontainers
class OutboxCleanupBatchingTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"))
            .withDatabaseName("order_test")
            .withUsername("test")
            .withPassword("test");

    @DynamicPropertySource
    static void overrideProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
    }

    @Configuration
    @EntityScan(basePackageClasses = OutboxMessage.class)
    @EnableJpaRepositories(basePackageClasses = OutboxRepository.class)
    @ImportAutoConfiguration({
            DataSourceAutoConfiguration.class,
            HibernateJpaAutoConfiguration.class,
            FlywayAutoConfiguration.class,
            TransactionAutoConfiguration.class
    })
    static class MinimalJpaSliceConfig {
    }

    @Autowired
    private OutboxRepository outboxRepository;

    @Autowired
    private DataSource dataSource;

    private JdbcTemplate jdbc;

    @org.junit.jupiter.api.BeforeEach
    void setUp() {
        this.jdbc = new JdbcTemplate(dataSource);
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM outbox");
    }

    private void seed(int count, boolean published, String interval) {
        jdbc.update("INSERT INTO outbox (id, topic, payload, partition_key, published, created_at, trace_headers) "
                + "SELECT gen_random_uuid(), 'test.topic', '{}'::jsonb, 'pk', " + published
                + ", now() - interval '" + interval + "', '{}'::jsonb "
                + "FROM generate_series(1, " + count + ")");
    }

    @Test
    void deletePublishedBatchRespectsItsLimit() {
        seed(250, true, "48 hours");
        int deleted = outboxRepository.deletePublishedBatch(OffsetDateTime.now().minusHours(24), 100);
        assertThat(deleted)
                .as("deletePublishedBatch must respect its limit; an unbounded delete is what this bound exists to prevent")
                .isEqualTo(100);
        assertThat(outboxRepository.count())
                .as("exactly 250 - 100 = 150 rows should remain after bounded delete")
                .isEqualTo(150);
    }

    @Test
    void jobDrainsTheBacklogAndSparesEverythingElse() {
        seed(250, true, "48 hours");    // deletable: published and old
        seed(3, true, "1 hour");         // published but inside retention, must survive
        seed(2, false, "48 hours");      // old but unpublished, must survive

        OutboxCleanupJob job = new OutboxCleanupJob(outboxRepository, 100, 100);
        job.purgePublished();

        assertThat(outboxRepository.count())
                .as("250 old + published should be deleted; 3 recent + published + 2 unpublished should remain")
                .isEqualTo(5);

        Long publishedOldCount = jdbc.queryForObject(
                "SELECT COUNT(*) FROM outbox WHERE published = true AND created_at < now() - interval '24 hours'",
                Long.class);
        assertThat(publishedOldCount)
                .as("all published rows older than retention window should be deleted")
                .isEqualTo(0L);

        Long unpublishedCount = jdbc.queryForObject(
                "SELECT COUNT(*) FROM outbox WHERE published = false",
                Long.class);
        assertThat(unpublishedCount)
                .as("cleanup must never touch unpublished rows because they have not been delivered yet")
                .isEqualTo(2L);
    }

    @Test
    void eachBatchCommitsSoAFailurePartWayKeepsItsProgress() {
        seed(250, true, "48 hours");

        // Mock the repository to fail on the third deletePublishedBatch call
        AtomicInteger calls = new AtomicInteger();
        OutboxRepository wrappedRepo = mock(OutboxRepository.class,
                AdditionalAnswers.delegatesTo(outboxRepository));
        doAnswer(inv -> {
            if (calls.incrementAndGet() == 3) {
                throw new RuntimeException("simulated database failure on the third batch");
            }
            return outboxRepository.deletePublishedBatch(inv.getArgument(0), inv.getArgument(1));
        }).when(wrappedRepo).deletePublishedBatch(any(), anyInt());

        // Job must NOT throw; it swallows and logs the exception
        new OutboxCleanupJob(wrappedRepo, 100, 100).purgePublished();

        assertThat(outboxRepository.count())
                .as("the first two batches must already be committed; if the job were @Transactional the failure would roll all of them back and the cleanup could never make progress on a backlog it cannot finish in one statement")
                .isEqualTo(50);
    }

    @Test
    void cleanupJobMustNotBeTransactional() throws NoSuchMethodException {
        assertThat(OutboxCleanupJob.class
                .getDeclaredMethod("purgePublished")
                .getAnnotation(org.springframework.transaction.annotation.Transactional.class))
                .as("purgePublished() must not be @Transactional: in production the job IS a "
                        + "Spring bean, so the annotation would wrap every batch in one outer "
                        + "transaction and a failure part-way would roll back all committed "
                        + "progress — the exact behaviour this change exists to remove. "
                        + "@Transactional belongs on OutboxRepository.deletePublishedBatch.")
                .isNull();
    }
}
