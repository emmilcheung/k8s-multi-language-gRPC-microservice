package com.ticketing.orders.integration;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.entity.OrderStatus;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.grpc.TicketServiceGrpc;
import com.ticketing.orders.grpc.ValidateTicketRequest;
import com.ticketing.orders.grpc.ValidateTicketResponse;
import com.ticketing.orders.repository.OrderRepository;
import com.ticketing.orders.repository.OrderTicketRepository;
import io.grpc.ManagedChannel;
import io.grpc.Server;
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
import org.testcontainers.containers.KafkaContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.math.BigDecimal;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Full-stack integration test — real PostgreSQL + Kafka via Testcontainers,
 * in-process gRPC server for ticket-service stub.
 *
 * Test data is isolated per-test: each test inserts its own seed data and the
 * database is reset between test classes via container lifecycle.
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

    @DynamicPropertySource
    static void overrideProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        registry.add("spring.kafka.bootstrap-servers", kafka::getBootstrapServers);
    }

    // ── In-process gRPC stub for ticket-service ───────────────────────────────

    static Server grpcServer;
    static ManagedChannel grpcChannel;

    /** Minimal ticket-service stub that always returns "available". */
    static class StubTicketService extends TicketServiceGrpc.TicketServiceImplBase {
        @Override
        public void validateTicketAvailability(
                ValidateTicketRequest request,
                StreamObserver<ValidateTicketResponse> responseObserver) {
            responseObserver.onNext(ValidateTicketResponse.newBuilder()
                    .setAvailable(true)
                    .build());
            responseObserver.onCompleted();
        }
    }

    @TestConfiguration
    static class GrpcTestConfig {
        @Bean
        @Primary
        TicketServiceGrpc.TicketServiceBlockingStub ticketServiceBlockingStub() throws Exception {
            String serverName = InProcessServerBuilder.generateName();
            grpcServer = InProcessServerBuilder.forName(serverName)
                    .directExecutor()
                    .addService(new StubTicketService())
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

    private final UUID userId = UUID.randomUUID();
    private UUID ticketId;

    @BeforeEach
    void seedTicket() {
        ticketId = UUID.randomUUID();
        orderTicketRepository.save(new OrderTicket(ticketId, "Test Concert", new BigDecimal("79.99")));
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
                .andExpect(jsonPath("$.status").value("CREATED"))
                .andExpect(jsonPath("$.ticket.id").value(ticketId.toString()))
                .andReturn();

        JsonNode json = objectMapper.readTree(result.getResponse().getContentAsString());
        assertThat(json.path("id").asText()).isNotBlank();
    }

    @Test
    void createOrder_returns_400_when_ticket_already_reserved() throws Exception {
        String body = """
                { "ticketId": "%s" }
                """.formatted(ticketId);

        // First order
        mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated());

        // Second order for same ticket — should be rejected
        mockMvc.perform(post("/api/orders")
                        .header("X-User-Id", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("BAD_REQUEST"));
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
                .andExpect(jsonPath("$.status").value("CANCELLED"));
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
}
