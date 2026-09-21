package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class OutboxMessagePublisherTest {

    @Mock
    private OutboxRepository outboxRepository;

    @Mock
    private KafkaTemplate<String, String> kafkaTemplate;

    /**
     * A broker that accepts the connection but never acknowledges is indistinguishable from a
     * future that never completes — and that is the dangerous case, because the relay holds a
     * FOR UPDATE SKIP LOCKED claim over the whole batch while this call blocks. With an
     * unbounded get() the claim would be pinned for delivery.timeout.ms (~2 minutes), during
     * which no other replica can touch those rows.
     *
     * assertTimeoutPreemptively is deliberate: it aborts and fails, whereas a plain elapsed-time
     * assertion would hang forever if the bound were removed.
     */
    @Test
    void publishOne_shouldGiveUpWithinTheTimeout_whenBrokerNeverAcknowledges() {
        CompletableFuture<SendResult<String, String>> neverCompletes = new CompletableFuture<>();
        when(kafkaTemplate.send(any(ProducerRecord.class))).thenReturn(neverCompletes);

        OutboxMessagePublisher publisher =
                new OutboxMessagePublisher(outboxRepository, kafkaTemplate, 100L);
        OutboxMessage msg = new OutboxMessage("orders.order.created", "{}", "order-1");

        boolean published = assertTimeoutPreemptively(Duration.ofSeconds(5),
                () -> publisher.publishOne(msg));

        assertThat(published)
                .as("a record the broker never acknowledged must not be reported as published")
                .isFalse();
        verify(outboxRepository, never()).save(any(OutboxMessage.class));
    }

    /**
     * The row may only be marked published after the broker acknowledges. Marking first would
     * turn a send failure into a permanently lost event — the outbox's whole purpose is that
     * the row survives until delivery is confirmed.
     */
    @Test
    void publishOne_shouldMarkRowPublished_whenBrokerAcknowledges() {
        when(kafkaTemplate.send(any(ProducerRecord.class)))
                .thenReturn(CompletableFuture.completedFuture(null));

        OutboxMessagePublisher publisher =
                new OutboxMessagePublisher(outboxRepository, kafkaTemplate, 10_000L);
        OutboxMessage msg = new OutboxMessage("orders.order.created", "{}", "order-1");

        assertThat(publisher.publishOne(msg)).isTrue();
        assertThat(msg.isPublished()).isTrue();
        verify(outboxRepository).save(msg);
    }
}
