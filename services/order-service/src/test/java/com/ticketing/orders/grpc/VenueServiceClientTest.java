package com.ticketing.orders.grpc;

import io.grpc.Status;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

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
        // C-8 pre-check: venue-service rejects a reserve on a RELEASED id with this phrase.
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
}
