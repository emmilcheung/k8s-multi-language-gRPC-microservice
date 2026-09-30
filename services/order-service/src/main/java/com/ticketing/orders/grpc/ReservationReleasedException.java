package com.ticketing.orders.grpc;

/** venue-service refused a reserve because the reservationId is already RELEASED/EXPIRED. */
public class ReservationReleasedException extends RuntimeException {
    public ReservationReleasedException(String message) {
        super(message);
    }
}
