package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration;
import org.springframework.boot.hibernate.autoconfigure.HibernateJpaAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.transaction.autoconfigure.TransactionAutoConfiguration;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Proves that concurrent outbox-relay replicas claim disjoint row sets.
 *
 * <p>Seeds 3 unpublished outbox rows, then opens two overlapping database
 * transactions — the second nested as {@code PROPAGATION_REQUIRES_NEW} while the
 * first is still open and uncommitted, so both are genuinely live at once, exactly
 * like two relay pods polling the outbox table at the same moment — and has each
 * claim rows via {@link OutboxRepository}. Without a bounded {@code LIMIT} and
 * {@code FOR UPDATE SKIP LOCKED}, both transactions see all 3 rows, so at least one
 * row would be picked up and published twice by two different replicas.
 *
 * <p>Runs against a real PostgreSQL via Testcontainers — row-locking semantics
 * ({@code FOR UPDATE SKIP LOCKED}) cannot be validated against an in-memory database.
 *
 * <p>{@code @DataJpaTest} is not on this project's classpath (adding it would
 * require a new Maven dependency), so this test wires the minimal JPA slice by hand
 * via {@link ImportAutoConfiguration} — DataSource + Hibernate/JPA + Flyway + the
 * transaction infrastructure only. This deliberately excludes Kafka, gRPC and the
 * real {@code @Scheduled} {@link OutboxRelay} bean, so the claim query can be
 * exercised in isolation without a Kafka broker.
 */
@SpringBootTest(
        classes = OutboxRelayConcurrencyTest.MinimalJpaSliceConfig.class,
        webEnvironment = SpringBootTest.WebEnvironment.NONE)
@ActiveProfiles("test")
@Testcontainers
class OutboxRelayConcurrencyTest {

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
    private PlatformTransactionManager transactionManager;

    @AfterEach
    void cleanUp() {
        outboxRepository.deleteAll();
    }

    @Test
    void concurrentReplicasClaimDisjointRows() {
        outboxRepository.save(new OutboxMessage("test.topic", "{}", "pk-1"));
        outboxRepository.save(new OutboxMessage("test.topic", "{}", "pk-2"));
        outboxRepository.save(new OutboxMessage("test.topic", "{}", "pk-3"));

        // To reproduce the RED, drop the @Lock(PESSIMISTIC_WRITE) / @QueryHints
        // lock.timeout = -2 pair from OutboxRepository.findUnpublished — that pair is
        // what Hibernate renders as FOR UPDATE SKIP LOCKED. Without it both
        // transactions see all 3 rows and the doesNotContain assertion below fails.
        // Assertions are not touched between the two runs.
        Supplier<List<OutboxMessage>> claim = () -> outboxRepository.findUnpublished(Pageable.ofSize(10));

        List<UUID> firstClaimIds = new ArrayList<>();
        List<UUID> secondClaimIds = new ArrayList<>();

        TransactionTemplate firstTx = new TransactionTemplate(transactionManager);
        firstTx.execute(status -> {
            firstClaimIds.addAll(claim.get().stream().map(OutboxMessage::getId).toList());

            // Opened while the first transaction's claim is still uncommitted, so this
            // models a second relay replica polling concurrently.
            TransactionTemplate secondTx = new TransactionTemplate(transactionManager);
            secondTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            secondTx.execute(innerStatus -> {
                secondClaimIds.addAll(claim.get().stream().map(OutboxMessage::getId).toList());
                return null;
            });
            return null;
        });

        for (UUID id : secondClaimIds) {
            assertThat(firstClaimIds)
                    .as("outbox row %s was claimed by both transactions; SKIP LOCKED not "
                            + "working — replicas will double-publish", id)
                    .doesNotContain(id);
        }

        int totalClaimed = firstClaimIds.size() + secondClaimIds.size();
        assertThat(totalClaimed)
                .as("expected both transactions to together claim all 3 seeded rows, got %d",
                        totalClaimed)
                .isEqualTo(3);
    }
}
