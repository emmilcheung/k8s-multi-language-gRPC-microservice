package com.ticketing.orders.kafka;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ticketing.orders.entity.OrderTicket;
import com.ticketing.orders.repository.OrderTicketRepository;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * Maintains the local replica of ticket data consumed from ticket-service events.
 *
 * Handles:
 *   - tickets.ticket.created  → upsert an OrderTicket row
 *   - tickets.ticket.updated  → update title / price on existing row
 *
 * Idempotent: re-processing the same event is safe because we upsert by ticket ID.
 * Offsets are committed AFTER successful DB write (AGENTS.md §3.5).
 */
@Component
public class TicketEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(TicketEventConsumer.class);

    private final OrderTicketRepository orderTicketRepository;
    private final ObjectMapper objectMapper;

    public TicketEventConsumer(OrderTicketRepository orderTicketRepository,
                               ObjectMapper objectMapper) {
        this.orderTicketRepository = orderTicketRepository;
        this.objectMapper = objectMapper;
    }

    @KafkaListener(
            topics = {"tickets.ticket.created", "tickets.ticket.updated"},
            groupId = "order-service",
            containerFactory = "kafkaListenerContainerFactory"
    )
    @Transactional
    public void onTicketEvent(ConsumerRecord<String, String> record, Acknowledgment ack) {
        Context parentContext = KafkaTraceContext.extractContext(record);
        Span span = GlobalOpenTelemetry.getTracer("order-service")
                .spanBuilder("kafka consume " + record.topic())
                .setParent(parentContext)
                .setSpanKind(SpanKind.CONSUMER)
                .startSpan();
        try {
            try (Scope ignored = span.makeCurrent()) {
                JsonNode root = objectMapper.readTree(record.value());
                JsonNode data = root.path("data");

                UUID ticketId = UUID.fromString(data.path("id").asText());
                String title = data.path("title").asText();
                BigDecimal price = new BigDecimal(data.path("price").asText());

                orderTicketRepository.findById(ticketId).ifPresentOrElse(
                        existing -> {
                            existing.setTitle(title);
                            existing.setPrice(price);
                            orderTicketRepository.save(existing);
                            log.info("Ticket replica updated ticketId={}", ticketId);
                        },
                        () -> {
                            orderTicketRepository.save(new OrderTicket(ticketId, title, price));
                            log.info("Ticket replica created ticketId={}", ticketId);
                        }
                );

                ack.acknowledge();
            }
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            log.error("Failed to process ticket event: {}", e.getMessage(), e);
            // Re-throw to trigger the configured error handler (DLQ after retries)
            throw new RuntimeException("Ticket event processing failed", e);
        } finally {
            span.end();
        }
    }
}
