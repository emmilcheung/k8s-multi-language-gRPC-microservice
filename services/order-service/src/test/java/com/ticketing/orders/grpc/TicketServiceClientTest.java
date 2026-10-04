package com.ticketing.orders.grpc;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class TicketServiceClientTest {

    private TicketServiceClient clientFailingWith(Status status) {
        var stub = mock(TicketServiceGrpc.TicketServiceBlockingStub.class);
        when(stub.withDeadlineAfter(anyLong(), any(TimeUnit.class))).thenReturn(stub);
        when(stub.reserveQuota(any())).thenThrow(status.asRuntimeException());
        return new TicketServiceClient(stub);
    }

    private void reserve(TicketServiceClient client) {
        client.reserveQuota("t", UUID.randomUUID(), UUID.randomUUID(), 1, Instant.now());
    }

    @Test
    void contract_inactive_prefix_equals_the_ticket_service_constant() {
        // Literal copy of ticket-service internal/grpc/server.go ReservationInactivePrefix.
        // Both sides assert the same string; changing one without the other must fail a test.
        assertThat(TicketServiceClient.RESERVATION_INACTIVE_PREFIX).isEqualTo("reservation no longer active: ");
    }

    @Test
    void inactive_reservation_is_surfaced_as_a_distinct_exception_for_key_exhaustion() {
        var client = clientFailingWith(Status.FAILED_PRECONDITION
                .withDescription(TicketServiceClient.RESERVATION_INACTIVE_PREFIX + "r is RELEASED"));

        assertThatThrownBy(() -> reserve(client)).isInstanceOf(ReservationReleasedException.class);
    }

    @Test
    void purchase_limit_failed_precondition_keeps_the_generic_422() {
        var client = clientFailingWith(Status.FAILED_PRECONDITION
                .withDescription("per-user limit exceeded for ticket t"));

        assertThatThrownBy(() -> reserve(client))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("422")
                .hasMessageContaining("Purchase limit exceeded");
    }

    @Test
    void circuit_breaker_fallback_passes_the_inactive_signal_through_instead_of_503() throws Exception {
        // Resilience4j picks the most specific fallback overload; without this one the signal
        // would fall into the Throwable fallback and become a 503.
        Method fallback = TicketServiceClient.class.getDeclaredMethod("reserveQuotaFallback",
                String.class, UUID.class, UUID.class, int.class, Instant.class,
                ReservationReleasedException.class);
        fallback.setAccessible(true);
        var signal = new ReservationReleasedException("x");

        assertThatThrownBy(() -> {
            try {
                fallback.invoke(clientFailingWith(Status.OK), "t", UUID.randomUUID(), UUID.randomUUID(), 1,
                        Instant.now(), signal);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
        }).isSameAs(signal);
    }

    private TicketServiceClient finalizeFailingWith(Status status) {
        var stub = mock(TicketServiceGrpc.TicketServiceBlockingStub.class);
        when(stub.withDeadlineAfter(anyLong(), any(TimeUnit.class))).thenReturn(stub);
        when(stub.finalizeReservation(any())).thenThrow(status.asRuntimeException());
        return new TicketServiceClient(stub);
    }

    @Test
    void finalize_reports_a_released_reservation_as_gone_so_the_order_is_refunded() {
        var client = finalizeFailingWith(Status.FAILED_PRECONDITION
                .withDescription("reservation no longer active: r is RELEASED"));

        assertThat(client.finalizeReservation(UUID.randomUUID(), "o")).isFalse();
    }

    @Test
    void finalize_reports_an_unknown_reservation_as_gone() {
        var client = finalizeFailingWith(Status.NOT_FOUND);

        assertThat(client.finalizeReservation(UUID.randomUUID(), "o")).isFalse();
    }

    @Test
    void finalize_throws_when_ticket_service_is_unavailable_because_an_outage_is_not_proof_the_quota_is_gone() {
        var client = finalizeFailingWith(Status.UNAVAILABLE);

        assertThatThrownBy(() -> client.finalizeReservation(UUID.randomUUID(), "o"))
                .isInstanceOf(StatusRuntimeException.class);
    }
}
