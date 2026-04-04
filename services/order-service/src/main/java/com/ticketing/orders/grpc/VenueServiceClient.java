package com.ticketing.orders.grpc;

import com.google.protobuf.Timestamp;
import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * Thin wrapper around the VenueService gRPC blocking stub.
 *
 * Applies explicit deadlines on every call, a Resilience4j circuit breaker
 * (name "venueService"), and maps gRPC status codes to HTTP exceptions so the
 * service layer stays free of gRPC concerns.
 *
 * CP-12: supports the seated order flow — reserve held seats (manual), auto-assign
 * and reserve (auto-assign), release (compensation), and finalize (payment captured).
 */
@Component
public class VenueServiceClient {

    private static final Logger log = LoggerFactory.getLogger(VenueServiceClient.class);
    private static final int WRITE_DEADLINE_SECONDS = 10;

    private final VenueServiceGrpc.VenueServiceBlockingStub stub;

    public VenueServiceClient(VenueServiceGrpc.VenueServiceBlockingStub stub) {
        this.stub = stub;
    }

    // ── Plan metadata ────────────────────────────────────────────────────────

    /**
     * Fetches seating plan metadata including assignment mode.
     * Used for validation before order creation.
     *
     * @param planId seating plan UUID (string form)
     * @return plan response with assignment mode
     */
    public GetSeatingPlanResponse getSeatingPlan(String planId) {
        try {
            GetSeatingPlanRequest request = GetSeatingPlanRequest.newBuilder()
                    .setPlanId(planId)
                    .build();
            return stub.withDeadlineAfter(WRITE_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .getSeatingPlan(request);
        } catch (StatusRuntimeException e) {
            throw mapVenueGrpcStatus(e, "GetSeatingPlan");
        }
    }

    // ── Manual-seated path ────────────────────────────────────────────────────

    /**
     * Converts a list of client-held seat IDs into confirmed reservations.
     *
     * @param planId        seating plan UUID (string form)
     * @param ticketId      ticket UUID (string form)
     * @param reservationId order-service-generated idempotency key
     * @param userId        authenticated user
     * @param seatIds       specific seat UUIDs the client has held
     * @param expiresAt     reservation expiry
     * @return response; check {@code getSuccess()} before proceeding
     */
    @CircuitBreaker(name = "venueService", fallbackMethod = "reserveHeldSeatsFallback")
    public ReserveHeldSeatsResponse reserveHeldSeats(
            String planId,
            String ticketId,
            UUID reservationId,
            UUID userId,
            List<String> seatIds,
            Instant expiresAt) {
        try {
            ReserveHeldSeatsRequest request = ReserveHeldSeatsRequest.newBuilder()
                    .setPlanId(planId)
                    .setTicketId(ticketId)
                    .setReservationId(reservationId.toString())
                    .setUserId(userId.toString())
                    .addAllSeatIds(seatIds)
                    .setExpiresAt(Timestamp.newBuilder()
                            .setSeconds(expiresAt.getEpochSecond())
                            .setNanos(expiresAt.getNano())
                            .build())
                    .build();
            return stub.withDeadlineAfter(WRITE_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .reserveHeldSeats(request);
        } catch (StatusRuntimeException e) {
            throw mapVenueGrpcStatus(e, "ReserveHeldSeats");
        }
    }

    // ── Auto-assign path ──────────────────────────────────────────────────────

    /**
     * Asks venue-service to pick and reserve {@code quantity} seats in a section
     * automatically.
     *
     * @param planId        seating plan UUID (string form)
     * @param ticketId      ticket UUID (string form)
     * @param sectionId     section UUID (string form) to assign from
     * @param reservationId order-service-generated idempotency key
     * @param userId        authenticated user
     * @param quantity      number of seats to assign
     * @param expiresAt     reservation expiry
     * @return response containing the assigned seats list
     */
    @CircuitBreaker(name = "venueService", fallbackMethod = "autoAssignAndReserveFallback")
    public AutoAssignAndReserveResponse autoAssignAndReserve(
            String planId,
            String ticketId,
            String sectionId,
            UUID reservationId,
            UUID userId,
            int quantity,
            Instant expiresAt) {
        try {
            AutoAssignAndReserveRequest request = AutoAssignAndReserveRequest.newBuilder()
                    .setPlanId(planId)
                    .setTicketId(ticketId)
                    .setSectionId(sectionId)
                    .setReservationId(reservationId.toString())
                    .setUserId(userId.toString())
                    .setQuantity(quantity)
                    .setExpiresAt(Timestamp.newBuilder()
                            .setSeconds(expiresAt.getEpochSecond())
                            .setNanos(expiresAt.getNano())
                            .build())
                    .build();
            return stub.withDeadlineAfter(WRITE_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .autoAssignAndReserve(request);
        } catch (StatusRuntimeException e) {
            throw mapVenueGrpcStatus(e, "AutoAssignAndReserve");
        }
    }

    // ── Compensation path ─────────────────────────────────────────────────────

    /**
     * Releases a seat reservation — best-effort, never throws.
     * Called when the DB transaction fails after a successful gRPC reservation.
     *
     * @param reservationId the reservation to release
     * @param reason        human-readable reason (e.g. "COMPENSATION")
     */
    public void releaseSeatReservation(UUID reservationId, String reason) {
        try {
            ReleaseSeatReservationRequest request = ReleaseSeatReservationRequest.newBuilder()
                    .setReservationId(reservationId.toString())
                    .setReason(reason)
                    .build();
            stub.withDeadlineAfter(WRITE_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .releaseSeatReservation(request);
            log.info("Venue seat reservation released reservationId={}", reservationId);
        } catch (StatusRuntimeException e) {
            log.warn("Venue releaseSeatReservation failed reservationId={} gRPC status={}",
                    reservationId, e.getStatus(), e);
        } catch (Exception e) {
            log.warn("Venue releaseSeatReservation failed reservationId={}: {}",
                    reservationId, e.getMessage(), e);
        }
    }

    // ── Finalize path (called by Kafka completed handler) ─────────────────────

    /**
     * Marks a seat reservation as finalized (SOLD) after payment is captured.
     * Best-effort: swallows all exceptions and logs at WARN.
     *
     * @param reservationId the reservation to finalize
     * @param orderId       the completed order ID
     */
    public void finalizeSeatReservation(UUID reservationId, String orderId) {
        try {
            FinalizeSeatReservationRequest request = FinalizeSeatReservationRequest.newBuilder()
                    .setReservationId(reservationId.toString())
                    .setOrderId(orderId)
                    .build();
            stub.withDeadlineAfter(WRITE_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .finalizeSeatReservation(request);
            log.info("Venue seat reservation finalized reservationId={} orderId={}", reservationId, orderId);
        } catch (StatusRuntimeException e) {
            log.warn("Venue finalizeSeatReservation failed reservationId={} orderId={} gRPC status={}",
                    reservationId, orderId, e.getStatus(), e);
        } catch (Exception e) {
            log.warn("Venue finalizeSeatReservation failed reservationId={} orderId={}: {}",
                    reservationId, orderId, e.getMessage(), e);
        }
    }

    // ── gRPC status code mapping ───────────────────────────────────────────────

    private RuntimeException mapVenueGrpcStatus(StatusRuntimeException e, String operation) {
        Status.Code code = e.getStatus().getCode();
        String description = e.getStatus().getDescription();
        log.error("Venue gRPC call failed: operation={} status={}", operation, e.getStatus(), e);
        return switch (code) {
            case NOT_FOUND ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Seating plan or seats not found");
            case INVALID_ARGUMENT ->
                new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Invalid request: " + description);
            case RESOURCE_EXHAUSTED ->
                new ResponseStatusException(HttpStatus.CONFLICT,
                        "Seats are no longer available");
            case FAILED_PRECONDITION ->
                new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Seats cannot be reserved in current state");
            case UNAVAILABLE, DEADLINE_EXCEEDED ->
                new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "Venue service is temporarily unavailable. Please try again shortly.");
            default ->
                new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                        "An unexpected error occurred while contacting venue-service.");
        };
    }

    // ── Circuit-breaker fallbacks ─────────────────────────────────────────────

    @SuppressWarnings("unused")
    private ReserveHeldSeatsResponse reserveHeldSeatsFallback(
            String planId, String ticketId, UUID reservationId, UUID userId,
            List<String> seatIds, Instant expiresAt, CallNotPermittedException ex) {
        log.warn("Circuit breaker OPEN for venue-service — rejecting reserveHeldSeats planId={}", planId);
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Venue service is temporarily unavailable. Please try again shortly.");
    }

    @SuppressWarnings("unused")
    private ReserveHeldSeatsResponse reserveHeldSeatsFallback(
            String planId, String ticketId, UUID reservationId, UUID userId,
            List<String> seatIds, Instant expiresAt, Throwable ex) {
        log.warn("Circuit breaker fallback for venue-service reserveHeldSeats planId={} reason={}",
                planId, ex.getMessage());
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Venue service is temporarily unavailable. Please try again shortly.");
    }

    @SuppressWarnings("unused")
    private AutoAssignAndReserveResponse autoAssignAndReserveFallback(
            String planId, String ticketId, String sectionId, UUID reservationId,
            UUID userId, int quantity, Instant expiresAt, CallNotPermittedException ex) {
        log.warn("Circuit breaker OPEN for venue-service — rejecting autoAssignAndReserve planId={}", planId);
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Venue service is temporarily unavailable. Please try again shortly.");
    }

    @SuppressWarnings("unused")
    private AutoAssignAndReserveResponse autoAssignAndReserveFallback(
            String planId, String ticketId, String sectionId, UUID reservationId,
            UUID userId, int quantity, Instant expiresAt, Throwable ex) {
        log.warn("Circuit breaker fallback for venue-service autoAssignAndReserve planId={} reason={}",
                planId, ex.getMessage());
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Venue service is temporarily unavailable. Please try again shortly.");
    }
}
