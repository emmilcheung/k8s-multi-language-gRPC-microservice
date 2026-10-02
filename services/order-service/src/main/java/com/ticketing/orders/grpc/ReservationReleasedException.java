package com.ticketing.orders.grpc;

/** venue-service or ticket-service refused a reserve because the reservationId is no longer active. */
public class ReservationReleasedException extends RuntimeException {
    public ReservationReleasedException(String message) {
        super(message);
    }
}
