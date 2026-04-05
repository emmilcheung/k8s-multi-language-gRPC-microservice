package com.ticketing.orders.integration;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.grpc.ReleaseReservationRequest;
import com.ticketing.orders.grpc.ReleaseReservationResponse;
import com.ticketing.orders.grpc.ReserveQuotaRequest;
import com.ticketing.orders.grpc.ReserveQuotaResponse;
import com.ticketing.orders.grpc.TicketServiceGrpc;
import com.ticketing.orders.grpc.ValidateTicketRequest;
import com.ticketing.orders.grpc.ValidateTicketResponse;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import com.ticketing.orders.service.OrderService;
import io.grpc.ManagedChannel;
import io.grpc.Server;
import io.grpc.Status;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.kafka.core.KafkaTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.KafkaContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Full-stack integration test — real PostgreSQL + Kafka via Testcontainers,
 * in-process gRPC server for ticket-service stub.
 *
 * CP-05: stub now implements {@code ReserveQuota} (GA path) and
 * {@code ReleaseReservation} (compensation path) in addition to the legacy
 * {@code ValidateTicketAvailability}. The concurrency test uses an atomic flag
 * on the stub to simulate ticket-service returning RESOURCE_EXHAUSTED on the
 * second concurrent reservation attempt — exactly what the real ticket-service
 * does when the per-ticket quota is exhausted.
 *
 * Test data is isolated per-test: each test inserts its own seed data and the
 * database is reset between tests via {@code @AfterEach}.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Testcontainers
class OrderIntegrationTest {

    // ── Containers ────────────────────────────────────────────────────────────

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"))
            .withDatabaseName("order_test")
            .withUsername("test")
            .withPassword("test");

    @Container
    static KafkaContainer kafka = new KafkaContainer(
            DockerImageName.parse("confluentinc/cp-kafka:7.6.1"));

    @Container
    static GenericContainer<?> redis = new GenericContainer<>(
            DockerImageName.parse("redis:7-alpine")).withExposedPorts(6379);

    @DynamicPropertySource
    static void overrideProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        registry.add("spring.kafka.bootstrap-servers", kafka::getBootstrapServers);
        registry.add("redis.url", () -> "redis://" + redis.getHost() + ":" + redis.getMappedPort(6379));
    }

    // ── In-process gRPC stub for ticket-service ───────────────────────────────

    static Server grpcServer;
    static ManagedChannel grpcChannel;

    /**
     * Minimal ticket-service stub.
     *
     * <ul>
     *   <li>{@code ReserveQuota} — succeeds on the first call per test; if
     *       {@link #reservedOnce} is already set, returns RESOURCE_EXHAUSTED to
     *       simulate a sold-out / quota-exceeded scenario (used by the concurrency
     *       test).  Each test resets the flag via {@link #reset()}.
     *   <li>{@code ReleaseReservation} — always succeeds (best-effort compensation).
     *   <li>{@code ValidateTicketAvailability} — kept for legacy compatibility.
     * </ul>
     */
    static class StubTicketService extends TicketServiceGrpc.TicketServiceImplBase {

        /** Set to true after the first ReserveQuota is accepted. */
        final AtomicBoolean reservedOnce = new AtomicBoolean(false);

        void reset() {
            reservedOnce.set(false);
        }

        @Override
        public void reserveQuota(
                ReserveQuotaRequest request,
                StreamObserver<ReserveQuotaResponse> responseObserver) {
            if (reservedOnce.compareAndSet(false, true)) {
                responseObserver.onNext(ReserveQuotaResponse.newBuilder()
                        .setSuccess(true)
                        .setReservationId(UUID.randomUUID().toString())
                        .setTicketId(request.getTicketId())
                        .setTitle("Test Concert")
                        .setPrice("79.99")
                        .setQuantity(request.getQuantity())
                        .setRemaining(9)
                        .build());
                responseObserver.onCompleted();
            } else {
                // Quota exhausted — the second concurrent caller gets 409 via RESOURCE_EXHAUSTED
                responseObserver.onError(
                        Status.RESOURCE_EXHAUSTED
                                .withDescription("Ticket quota exhausted")
                                .asRuntimeException());
            }
        }

        @Override
        public void releaseReservation(
                ReleaseReservationRequest request,
                StreamObserver<ReleaseReservationResponse> responseObserver) {
            responseObserver.onNext(ReleaseReservationResponse.newBuilder().build());
            responseObserver.onCompleted();
        }

        @Override
        public void validateTicketAvailability(
                ValidateTicketRequest request,
                StreamObserver<ValidateTicketResponse> responseObserver) {
            responseObserver.onNext(ValidateTicketResponse.newBuilder()
                    .setAvailable(true)
                    .setTicketId(request.getTicketId())
                    .setTitle("Test Concert")
                    .setPrice("79.99")
                    .build());
            responseObserver.onCompleted();
        }
    }

    static StubTicketService stubTicketService;

    @TestConfiguration
    static class GrpcTestConfig {
        @Bean
        @Primary
        TicketServiceGrpc.TicketServiceBlockingStub ticketServiceBlockingStub() throws Exception {
            String serverName = InProcessServerBuilder.generateName();
            stubTicketService = new StubTicketService();
            grpcServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(stubTicketService)
                    .build()
                    .start();
            grpcChannel = InProcessChannelBuilder.forName(serverName)
                    .directExecutor()
                    .build();
            return TicketServiceGrpc.newBlockingStub(grpcChannel);
        }
    }

    @AfterAll
    static void tearDownGrpc() {
        if (grpcChannel != null) grpcChannel.shutdownNow();
        if (grpcServer != null) grpcServer.shutdownNow();
    }

    // ── Test wiring ───────────────────────────────────────────────────────────

    @Autowired MockMvc mockMvc;
    @Autowired ObjectMapper objectMapper;
    @Autowired OrderTicketRepository orderTicketRepository;
    @Autowired OrderRepository orderRepository;
    @Autowired OrderService orderService;
    @Autowired KafkaTemplate<String, String> kafkaTemplate;

    private final UUID userId = UUID.randomUUID();
    private UUID ticketId;

    @BeforeEach
    void setUp() {
        ticketId = UUID.randomUUID();
        orderTicketRepository.save(new OrderTicket(ticketId, "Test Concert", new BigDecimal("79.99")));
        // Reset the stub's reservation gate so each test starts fresh
        if (stubTicketService != null) {
            stubTicketService.reset();
        }
    }

    @AfterEach
    void cleanup() {
        orderRepository.deleteAll();
        orderTicketRepository.deleteAll();
    }

    // ── POST /api/orders ──────────────────────────────────────────────────────

    @Test
    void createOrder_returns_201_and_order_body() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        MvcResult result = mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("created"))
                .andExpect(jsonPath("$.ticket.id").value(ticketId.toString()))
                .andReturn();

        JsonNode json = objectMapper.readTree(result.getResponse().getContentAsString());
        assertThat(json.path("id").asText()).isNotBlank();
        assertThat(json.path("quantity").asInt()).isEqualTo(1);
    }

    @Test
    void createOrder_returns_409_when_ticket_quota_exhausted() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        // First order — succeeds (stub allows one reservation)
        mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated());

        // Second order for same ticket — stub returns RESOURCE_EXHAUSTED → 409 CONFLICT
        mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isConflict());
    }

    @Test
    void createOrder_returns_409_or_201_when_concurrent_requests_for_same_ticket() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        List<Integer> statuses = Collections.synchronizedList(new ArrayList<>());

        Runnable createOrderCall = () -> {
            try {
                ready.countDown();
                start.await(5, TimeUnit.SECONDS);
                int status = mockMvc.perform(post("/api/orders")
                                .header("X-User-Id", UUID.randomUUID())
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(body))
                        .andReturn()
                        .getResponse()
                        .getStatus();
                statuses.add(status);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        };

        CompletableFuture<Void> f1 = CompletableFuture.runAsync(createOrderCall, executor);
        CompletableFuture<Void> f2 = CompletableFuture.runAsync(createOrderCall, executor);

        assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
        start.countDown();

        f1.get(10, TimeUnit.SECONDS);
        f2.get(10, TimeUnit.SECONDS);
        executor.shutdownNow();

        long createdCount = statuses.stream().filter(s -> s == 201).count();
        long conflictOrBadRequest = statuses.stream().filter(s -> s == 409 || s == 400).count();

        assertThat(statuses).hasSize(2);
        assertThat(createdCount).isEqualTo(1);
        assertThat(conflictOrBadRequest).isEqualTo(1);
    }

    @Test
    void createOrder_returns_400_when_ticketId_missing() throws Exception {
        mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_FAILED"));
    }

    // ── GET /api/orders ───────────────────────────────────────────────────────

    @Test
    void listOrders_returns_empty_list_when_user_has_no_orders() throws Exception {
        mockMvc.perform(get("/api/orders")
                        .header("X-User-Id", UUID.randomUUID()))
                .andExpect(status().isOk())
                .andExpect(content().json("[]"));
    }

    @Test
    void listOrders_returns_orders_belonging_to_user() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated());

        mockMvc.perform(get("/api/orders")
                        .header("X-User-Id", userId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].userId").value(userId.toString()));
    }

    // ── GET /api/orders/{id} ──────────────────────────────────────────────────

    @Test
    void getOrder_returns_403_when_user_is_not_owner() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        MvcResult createResult = mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andReturn();

        String orderId = objectMapper.readTree(
                createResult.getResponse().getContentAsString()).path("id").asText();

        mockMvc.perform(get("/api/orders/" + orderId)
                        .header("X-User-Id", UUID.randomUUID()))
                .andExpect(status().isForbidden());
    }

    @Test
    void getOrder_returns_404_for_unknown_order() throws Exception {
        mockMvc.perform(get("/api/orders/" + UUID.randomUUID())
                        .header("X-User-Id", userId))
                .andExpect(status().isNotFound());
    }

    // ── DELETE /api/orders/{id} ───────────────────────────────────────────────

    @Test
    void cancelOrder_returns_cancelled_order() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        MvcResult createResult = mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andReturn();

        String orderId = objectMapper.readTree(
                createResult.getResponse().getContentAsString()).path("id").asText();

        mockMvc.perform(delete("/api/orders/" + orderId)
                        .header("X-User-Id", userId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("cancelled"));
    }

    @Test
    void cancelOrder_returns_400_when_order_already_cancelled() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        MvcResult createResult = mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andReturn();

        String orderId = objectMapper.readTree(
                createResult.getResponse().getContentAsString()).path("id").asText();

        // First cancel
        mockMvc.perform(delete("/api/orders/" + orderId)
                        .header("X-User-Id", userId))
                .andExpect(status().isOk());

        // Second cancel — already terminal
        mockMvc.perform(delete("/api/orders/" + orderId)
                        .header("X-User-Id", userId))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"));
    }

    // ── Kafka consumer integration ────────────────────────────────────────────

    @Test
    void paymentCapturedEvent_marks_order_complete() throws Exception {
        UUID orderId = createOrderAndReturnId(ticketId, userId);
        orderService.markAwaitingPayment(orderId);

        String event = """
                {
                  "specversion":"1.0",
                  "type":"payments.payment.captured",
                  "source":"payment-service",
                  "id":"%s",
                  "time":"%s",
                  "datacontenttype":"application/json",
                  "data":{"orderId":"%s"}
                }
                """.formatted(UUID.randomUUID(), OffsetDateTime.now(), orderId);

        publish("payments.payment.captured", event);
        awaitOrderStatus(orderId, OrderStatus.COMPLETE);
    }

    @Test
    void expirationEvent_cancels_non_terminal_order() throws Exception {
        UUID orderId = createOrderAndReturnId(ticketId, userId);

        String event = """
                {
                  "specversion":"1.0",
                  "type":"expiration.order.expiration_complete",
                  "source":"expiration-service",
                  "id":"%s",
                  "time":"%s",
                  "datacontenttype":"application/json",
                  "data":{"orderId":"%s"}
                }
                """.formatted(UUID.randomUUID(), OffsetDateTime.now(), orderId);

        publish("expiration.order.expiration_complete", event);
        awaitOrderStatus(orderId, OrderStatus.CANCELLED);
    }

    @Test
    void ticketUpdatedEvent_updates_local_ticket_replica() throws Exception {
        String updatedTitle = "Updated Concert Title";
        String event = """
                {
                  "specversion":"1.0",
                  "type":"tickets.ticket.updated",
                  "source":"ticket-service",
                  "id":"%s",
                  "time":"%s",
                  "datacontenttype":"application/json",
                  "data":{
                    "id":"%s",
                    "title":"%s",
                    "price":"120.50"
                  }
                }
                """.formatted(UUID.randomUUID(), OffsetDateTime.now(), ticketId, updatedTitle);

        publish("tickets.ticket.updated", event);

        awaitCondition(() -> orderTicketRepository.findById(ticketId)
                .map(t -> updatedTitle.equals(t.getTitle())
                        && new BigDecimal("120.50").compareTo(t.getPrice()) == 0)
                .orElse(false));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private UUID createOrderAndReturnId(UUID targetTicketId, UUID targetUserId) throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(targetTicketId);

        MvcResult result = mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", targetUserId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andReturn();

        return UUID.fromString(
                objectMapper.readTree(result.getResponse().getContentAsString()).path("id").asText());
    }

    private void publish(String topic, String payload) throws Exception {
        kafkaTemplate.send(topic, payload).get(10, TimeUnit.SECONDS);
    }

    private void awaitOrderStatus(UUID orderId, OrderStatus expected) throws Exception {
        awaitCondition(() -> orderRepository.findByIdWithTicket(orderId)
                .map(o -> o.getStatus() == expected)
                .orElse(false));
    }

    private void awaitCondition(Condition condition) throws Exception {
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline) {
            if (condition.ok()) {
                return;
            }
            Thread.sleep(100);
        }
        Assertions.fail("Condition not met within timeout");
    }

    @FunctionalInterface
    private interface Condition {
        boolean ok() throws Exception;
    }
}
