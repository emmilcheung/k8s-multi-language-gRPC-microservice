package com.ticketing.orders.outbox;

import com.ticketing.orders.entity.OutboxMessage;
import com.ticketing.orders.repository.OutboxRepository;
import jakarta.persistence.LockModeType;
import jakarta.persistence.QueryHint;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.QueryHints;
import org.springframework.transaction.annotation.Transactional;

import java.lang.reflect.Method;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class OutboxRelayTest {

    @Mock
    private OutboxRepository outboxRepository;

    @Mock
    private OutboxMessagePublisher publisher;

    private OutboxRelay relayWithBatchSize(int batchSize) {
        return new OutboxRelay(outboxRepository, publisher, batchSize);
    }

    /**
     * The relay must never ask for the whole unpublished backlog. During a Kafka outage the
     * backlog is exactly what grows, so an unbounded fetch turns a recoverable outage into an
     * OOM on the one component that is supposed to drain it.
     */
    @Test
    void relay_shouldClaimAtMostConfiguredBatchSize_whenBacklogExists() {
        when(outboxRepository.findUnpublished(any(Pageable.class))).thenReturn(List.of());

        relayWithBatchSize(50).relay();

        ArgumentCaptor<Pageable> pageable = ArgumentCaptor.forClass(Pageable.class);
        verify(outboxRepository).findUnpublished(pageable.capture());
        assertThat(pageable.getValue().getPageSize()).isEqualTo(50);
    }

    @Test
    void relay_shouldPublishEveryClaimedMessage_whenBatchIsReturned() {
        OutboxMessage first = new OutboxMessage("orders.order.created", "{}", "order-1");
        OutboxMessage second = new OutboxMessage("orders.order.cancelled", "{}", "order-2");
        when(outboxRepository.findUnpublished(any(Pageable.class))).thenReturn(List.of(first, second));
        when(publisher.publishOne(any(OutboxMessage.class))).thenReturn(true);

        relayWithBatchSize(50).relay();

        verify(publisher).publishOne(first);
        verify(publisher).publishOne(second);
        verify(publisher, times(2)).publishOne(any(OutboxMessage.class));
    }

    /**
     * Ordering guarantee, not just error handling. The outbox keys every record by orderId so
     * that events for one order stay in order on their partition (AGENTS.md §3.4). If the relay
     * skipped a failing row and carried on, a later event for that same order would reach Kafka
     * ahead of the earlier one still being retried — an order could be observed cancelled before
     * it was created. Stopping the batch is what makes the partition key mean anything.
     */
    @Test
    void relay_shouldStopAtFailingMessage_soLaterEventsForTheSameKeyCannotOvertakeIt() {
        OutboxMessage otherOrder = new OutboxMessage("orders.order.created", "{}", "order-1");
        OutboxMessage failing = new OutboxMessage("orders.order.created", "{}", "order-2");
        OutboxMessage sameKeyLater = new OutboxMessage("orders.order.cancelled", "{}", "order-2");
        when(outboxRepository.findUnpublished(any(Pageable.class)))
                .thenReturn(List.of(otherOrder, failing, sameKeyLater));
        when(publisher.publishOne(otherOrder)).thenReturn(true);
        when(publisher.publishOne(failing)).thenReturn(false);

        relayWithBatchSize(50).relay();

        verify(publisher).publishOne(otherOrder);
        verify(publisher).publishOne(failing);
        verify(publisher, never()).publishOne(sameKeyLater);
    }

    @Test
    void relay_shouldNotPublish_whenNothingIsPending() {
        when(outboxRepository.findUnpublished(any(Pageable.class))).thenReturn(List.of());

        relayWithBatchSize(50).relay();

        verify(publisher, never()).publishOne(any(OutboxMessage.class));
    }

    /**
     * Replica isolation is enforced by annotations, not by code this test can drive: the
     * claim's correctness under 2–8 replicas depends on FOR UPDATE SKIP LOCKED being emitted,
     * and on the claim being held by a transaction that spans the publish loop. Both are
     * invisible to a mocked repository and only observable end-to-end with a real Postgres
     * (integration tests, Docker). This asserts the contract so that removing either one
     * fails here rather than silently double-publishing every event in production.
     */
    @Test
    void claimQuery_shouldUseSkipLockedInsideTheRelayTransaction() throws NoSuchMethodException {
        Method claim = OutboxRepository.class.getMethod("findUnpublished", Pageable.class);

        Lock lock = claim.getAnnotation(Lock.class);
        assertThat(lock).as("claim must take a row lock").isNotNull();
        assertThat(lock.value()).isEqualTo(LockModeType.PESSIMISTIC_WRITE);

        QueryHints hints = claim.getAnnotation(QueryHints.class);
        assertThat(hints).as("claim must carry a lock-timeout hint").isNotNull();
        assertThat(hints.value())
                .as("lock timeout -2 is Hibernate's SKIP_LOCKED; anything else makes replicas queue or fail")
                .extracting(QueryHint::name, QueryHint::value)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("jakarta.persistence.lock.timeout", "-2"));

        assertThat(OutboxRelay.class.getMethod("relay").getAnnotation(Transactional.class))
                .as("the claim's locks are released at commit, so the publish loop must run inside the claiming transaction")
                .isNotNull();
    }
}
