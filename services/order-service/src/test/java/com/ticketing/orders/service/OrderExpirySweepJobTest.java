package com.ticketing.orders.service;

import com.ticketing.orders.repository.OrderRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * the backstop that expires orders whose asynq job was lost in a Redis failover.
 */
@ExtendWith(MockitoExtension.class)
class OrderExpirySweepJobTest {

    @Mock
    private OrderRepository orderRepository;

    @Mock
    private OrderService orderService;

    @Test
    void sweep_shouldExpireEveryOverdueOrder_throughTheSamePathAsTheKafkaConsumer() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        when(orderRepository.findOverdueOpenOrderIds(any(), any(), eq(200))).thenReturn(List.of(a, b));

        new OrderExpirySweepJob(orderRepository, orderService, 300, 60, 200).sweep();

        // expireOrder is what emits orders.order.cancelled; a separate code path would let the
        // backstop and the normal path drift apart in which seats get released.
        verify(orderService).expireOrder(a);
        verify(orderService).expireOrder(b);
    }

    @Test
    void sweep_shouldLeaveTheGraceWindowToAsynq_whenChoosingTheCutoff() {
        when(orderRepository.findOverdueOpenOrderIds(any(), any(), anyInt())).thenReturn(List.of());

        new OrderExpirySweepJob(orderRepository, orderService, 300, 60, 200).sweep();

        ArgumentCaptor<OffsetDateTime> cutoff = ArgumentCaptor.forClass(OffsetDateTime.class);
        ArgumentCaptor<OffsetDateTime> paymentCutoff = ArgumentCaptor.forClass(OffsetDateTime.class);
        verify(orderRepository).findOverdueOpenOrderIds(
                cutoff.capture(), paymentCutoff.capture(), anyInt());
        assertThat(cutoff.getValue())
                .as("cutoff must be now - grace; a cutoff of now races the normal asynq path on every order")
                .isCloseTo(OffsetDateTime.now().minusSeconds(300), within(5, java.time.temporal.ChronoUnit.SECONDS));
        assertThat(paymentCutoff.getValue())
                .as("an AWAITING_PAYMENT order is due once it is the payment grace past its expiry; "
                        + "picking it up earlier would just have expireOrder defer it every tick")
                .isCloseTo(OffsetDateTime.now().minusSeconds(60), within(5, java.time.temporal.ChronoUnit.SECONDS));
    }

    @Test
    void sweep_shouldKeepGoing_whenOneOrderLosesARace() {
        UUID raced = UUID.randomUUID();
        UUID next = UUID.randomUUID();
        when(orderRepository.findOverdueOpenOrderIds(any(), any(), anyInt())).thenReturn(List.of(raced, next));
        // Another replica, the Kafka consumer, or a payment committed first: @Version rejects our write.
        doThrow(new ObjectOptimisticLockingFailureException("Order", raced))
                .when(orderService).expireOrder(raced);

        new OrderExpirySweepJob(orderRepository, orderService, 300, 60, 200).sweep();

        // Losing a race on one order must not strand the rest of the batch.
        verify(orderService).expireOrder(next);
    }

    @Test
    void sweep_shouldNotThrow_whenTheQueryFails() {
        when(orderRepository.findOverdueOpenOrderIds(any(), any(), anyInt()))
                .thenThrow(new RuntimeException("database unavailable"));

        // A throw from a @Scheduled method is only logged by Spring, but the job must stay quiet
        // and retry on the next tick rather than rely on that.
        new OrderExpirySweepJob(orderRepository, orderService, 300, 60, 200).sweep();

        verifyNoInteractions(orderService);
    }

    @Test
    void sweep_shouldNotBeTransactional() throws NoSuchMethodException {
        assertThat(OrderExpirySweepJob.class.getDeclaredMethod("sweep").getAnnotation(Transactional.class))
                .as("one outer transaction would make a single lost race roll back every other "
                        + "expiry in the batch; each expireOrder must commit on its own")
                .isNull();
    }
}
