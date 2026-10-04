package com.ticketing.orders.grpc;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class VenueServiceClientTest {

    private VenueServiceClient clientFailingWith(Status status) {
        var stub = mock(VenueServiceGrpc.VenueServiceBlockingStub.class);
        when(stub.withDeadlineAfter(anyLong(), any(TimeUnit.class))).thenReturn(stub);
        when(stub.reserveHeldSeats(any())).thenThrow(status.asRuntimeException());
        return new VenueServiceClient(stub);
    }

    private void reserve(VenueServiceClient client) {
        client.reserveHeldSeats("p", "t", UUID.randomUUID(), UUID.randomUUID(), List.of("s"), Instant.now());
    }

    @Test
    void released_reservation_is_surfaced_as_a_distinct_exception_for_key_exhaustion() {
        // Pre-check: venue-service rejects a reserve on a RELEASED id with this phrase.
        // It must not be flattened into the generic 422, or the caller cannot tell the key is dead.
        var client = clientFailingWith(Status.FAILED_PRECONDITION
                .withDescription("reservation r was already released"));

        assertThatThrownBy(() -> reserve(client)).isInstanceOf(ReservationReleasedException.class);
    }

    @Test
    void other_failed_preconditions_keep_the_generic_422() {
        var client = clientFailingWith(Status.FAILED_PRECONDITION.withDescription("reservation r was already sold"));

        assertThatThrownBy(() -> reserve(client))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("422");
    }

    private VenueServiceClient finalizeFailingWith(Status status) {
        var stub = mock(VenueServiceGrpc.VenueServiceBlockingStub.class);
        when(stub.withDeadlineAfter(anyLong(), any(TimeUnit.class))).thenReturn(stub);
        when(stub.finalizeSeatReservation(any())).thenThrow(status.asRuntimeException());
        return new VenueServiceClient(stub);
    }

    @Test
    void finalize_reports_a_released_reservation_as_gone_so_the_order_is_refunded() {
        var client = finalizeFailingWith(Status.FAILED_PRECONDITION
                .withDescription("reservation r was released and cannot be finalized"));

        assertThat(client.finalizeSeatReservation(UUID.randomUUID(), "o")).isFalse();
    }

    @Test
    void finalize_reports_an_unknown_reservation_as_gone() {
        var client = finalizeFailingWith(Status.NOT_FOUND);

        assertThat(client.finalizeSeatReservation(UUID.randomUUID(), "o")).isFalse();
    }

    @Test
    void finalize_throws_when_venue_is_unavailable_because_an_outage_is_not_proof_the_seats_are_gone() {
        var client = finalizeFailingWith(Status.UNAVAILABLE);

        assertThatThrownBy(() -> client.finalizeSeatReservation(UUID.randomUUID(), "o"))
                .isInstanceOf(StatusRuntimeException.class);
    }
}
