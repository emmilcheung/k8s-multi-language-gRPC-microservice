package com.ticketing.orders.repository;

import com.ticketing.orders.entity.Order;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
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
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import javax.sql.DataSource;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * the query behind OrderExpirySweepJob, against a real PostgreSQL.
 *
 * <p>The sweep is the only thing that expires an order whose asynq job was lost in a
 * Redis failover. If this query misses an open status the order holds its seats
 * forever; if it returns a terminal order the sweep does pointless work every minute;
 * if it can't use V7's partial index it scans every order ever placed, every minute.
 */
@SpringBootTest(
        classes = OverdueOpenOrdersQueryTest.MinimalJpaSliceConfig.class,
        webEnvironment = SpringBootTest.WebEnvironment.NONE)
@ActiveProfiles("test")
@Testcontainers
class OverdueOpenOrdersQueryTest {

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
    @EntityScan(basePackageClasses = Order.class)
    @EnableJpaRepositories(basePackageClasses = OrderRepository.class)
    @ImportAutoConfiguration({
            DataSourceAutoConfiguration.class,
            HibernateJpaAutoConfiguration.class,
            FlywayAutoConfiguration.class,
            TransactionAutoConfiguration.class
    })
    static class MinimalJpaSliceConfig {
    }

    private static final UUID TICKET_ID = UUID.randomUUID();

    @Autowired
    private OrderRepository orderRepository;

    @Autowired
    private DataSource dataSource;

    private JdbcTemplate jdbc;

    @BeforeEach
    void setUp() {
        jdbc = new JdbcTemplate(dataSource);
        jdbc.update("INSERT INTO order_tickets (id, title, price) VALUES (?, 'Show', 10)", TICKET_ID);
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM orders");
        jdbc.update("DELETE FROM order_tickets");
    }

    private UUID seed(String status, String expiredAgo) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO orders (id, user_id, status, expires_at, ticket_id) "
                + "VALUES (?, gen_random_uuid(), ?, now() - ?::interval, ?)", id, status, expiredAgo, TICKET_ID);
        return id;
    }

    @Test
    void findOverdueOpenOrderIds_shouldReturnOnlyOpenOrdersPastTheCutoff_oldestFirst() {
        UUID createdOld = seed("CREATED", "20 minutes");
        UUID awaitingOlder = seed("AWAITING_PAYMENT", "30 minutes");
        seed("AWAITING_PAYMENT", "30 seconds"); // inside the payment grace: not due yet
        seed("AWAITING_PAYMENT", "-10 minutes"); // not expired yet
        seed("COMPLETE", "30 minutes");          // paid: must never be expired
        seed("CANCELLED", "30 minutes");         // already terminal

        List<UUID> ids = due(100);

        assertThat(ids)
                .as("both open statuses must be swept — orders are created as CREATED, so sweeping only "
                        + "AWAITING_PAYMENT would leave most lost-job orders holding seats forever — and "
                        + "terminal or not-yet-overdue orders must never be returned")
                .containsExactly(awaitingOlder, createdOld);
    }

    private List<UUID> due(int limit) {
        OffsetDateTime now = OffsetDateTime.now();
        return orderRepository.findOverdueOpenOrderIds(now.minusMinutes(5), now.minusSeconds(60), limit);
    }

    @Test
    void findOverdueOpenOrderIds_shouldPickUpAwaitingPaymentAfterThePaymentGrace_andCreatedAfterTheSweepGrace() {
        UUID awaitingPastGrace = seed("AWAITING_PAYMENT", "90 seconds");
        seed("AWAITING_PAYMENT", "30 seconds");  // inside the payment grace: expireOrder would defer it
        seed("CREATED", "90 seconds");           // no payment: waits for the longer sweep grace
        UUID createdPastSweepGrace = seed("CREATED", "6 minutes");

        assertThat(due(100))
                .as("AWAITING_PAYMENT orders are picked up sooner than CREATED ones because venue "
                        + "releases the seats a minute after expiry; neither may be swept earlier")
                .containsExactly(createdPastSweepGrace, awaitingPastGrace);
    }

    @Test
    void findOverdueOpenOrderIds_shouldRespectItsLimit_whenTheBacklogIsLarger() {
        for (int i = 0; i < 5; i++) {
            seed("AWAITING_PAYMENT", (10 + i) + " minutes");
        }

        assertThat(orderRepository.findOverdueOpenOrderIds(
                OffsetDateTime.now(), OffsetDateTime.now(), 3))
                .as("the batch bound caps one sweep's work after a large job loss; the rest waits for the next run")
                .hasSize(3);
    }

    @Test
    void findOverdueOpenOrderIds_shouldBeServedByThePartialIndex() {
        // Seq scans disabled so the plan shows whether the index CAN serve the query; on a
        // near-empty table the planner would otherwise pick a seq scan regardless.
        String plan = jdbc.execute((ConnectionCallback<String>) conn -> {
            try (Statement st = conn.createStatement()) {
                st.execute("SET enable_seqscan = off");
                StringBuilder sb = new StringBuilder();
                try (ResultSet rs = st.executeQuery("EXPLAIN SELECT id FROM orders"
                        + " WHERE status IN ('CREATED', 'AWAITING_PAYMENT') AND expires_at < now() - interval '60 seconds'"
                        + " AND (status = 'AWAITING_PAYMENT' OR expires_at < now() - interval '5 minutes')"
                        + " ORDER BY expires_at LIMIT 200")) {
                    while (rs.next()) {
                        sb.append(rs.getString(1)).append('\n');
                    }
                }
                st.execute("RESET enable_seqscan");
                return sb.toString();
            }
        });

        assertThat(plan)
                .as("the sweep runs every minute on every replica; without V7's partial index it scans "
                        + "every order ever placed. The index predicate must match the query's status "
                        + "literals exactly or the planner can't use it. Plan:\n" + plan)
                .contains("idx_orders_open_expires_at");
    }
}
