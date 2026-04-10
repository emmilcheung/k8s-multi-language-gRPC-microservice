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
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * Thin wrapper around the gRPC stub — applies deadlines, a circuit breaker, and maps
 * gRPC errors to application exceptions.  Keeps gRPC concerns out of the service layer.
 *
 * Circuit breaker (R-01): when ticket-service is unreachable the circuit opens after
 * 50 % of 10 calls fail.  While open, the fallback methods are called immediately
 * (no 5-second deadline wait per request), returning a clear error to the caller
 * without cascading load onto order-service threads.
 *
 * Status mapping (R-13): gRPC status codes are translated to the appropriate HTTP
 * status codes rather than collapsing all errors into 400.
 *
 * CP-05: added {@link #reserveQuota} and {@link #releaseReservation} for the GA path.
 */
@Component
public class TicketServiceClient {

    private static final Logger log = LoggerFactory.getLogger(TicketServiceClient.class);
    private static final int READ_DEADLINE_SECONDS = 5;
    private static final int WRITE_DEADLINE_SECONDS = 10;

    private final TicketServiceGrpc.TicketServiceBlockingStub stub;

    public TicketServiceClient(TicketServiceGrpc.TicketServiceBlockingStub stub) {
        this.stub = stub;
    }

    // ── Legacy / deprecated ──────────────────────────────────────────────────────

    /**
     * Validates that the ticket exists and is available for purchase.
     *
     * @deprecated prefer {@link #reserveQuota} for the GA reservation flow.
     * Protected by the "ticketService" circuit breaker defined in application.yml.
     * On open circuit, {@link #validateAvailabilityFallback} is invoked instead.
     */
    @Deprecated
    @CircuitBreaker(name = "ticketService", fallbackMethod = "validateAvailabilityFallback")
    public ValidateTicketResponse validateAvailability(String ticketId) {
        try {
            ValidateTicketRequest request = ValidateTicketRequest.newBuilder()
                    .setTicketId(ticketId)
                    .build();
            ValidateTicketResponse response = stub.withDeadlineAfter(READ_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .validateTicketAvailability(request);
            if (!response.getAvailable()) {
                throw new com.ticketing.orders.exception.BadRequestException(
                        "Ticket is not available: " + ticketId);
            }
            return response;
        } catch (StatusRuntimeException e) {
            throw mapGrpcStatus(e, ticketId);
        }
    }

    // ── GA reservation path ────────────────────────────────────────────────────

    /**
     * Atomically reserves {@code quantity} units of a ticket via the GA gRPC path.
     *
     * <p>The caller must supply a {@code reservationId} generated before this call so that
     * the operation is idempotent on retry: if ticket-service already recorded a reservation
     * for the same {@code reservationId} with identical parameters, it returns success
     * without double-decrementing inventory.
     *
     * @param ticketId      ticket to reserve
     * @param reservationId caller-generated UUID (idempotency key)
     * @param userId        authenticated user
     * @param quantity      units to reserve (>= 1)
     * @param expiresAt     absolute expiry time for the reservation
     * @return response containing remaining inventory, title, price
     * @throws ResponseStatusException 409 if sold-out / per-user limit; 422 if invalid args;
     *                                 404 if ticket not found; 503 if service unavailable
     */
    @CircuitBreaker(name = "ticketService", fallbackMethod = "reserveQuotaFallback")
    public ReserveQuotaResponse reserveQuota(
            String ticketId, UUID reservationId, UUID userId, int quantity, Instant expiresAt) {
        try {
            ReserveQuotaRequest request = ReserveQuotaRequest.newBuilder()
                    .setTicketId(ticketId)
                    .setReservationId(reservationId.toString())
                    .setUserId(userId.toString())
                    .setQuantity(quantity)
                    .setExpiresAt(Timestamp.newBuilder()
                            .setSeconds(expiresAt.getEpochSecond())
                            .setNanos(expiresAt.getNano())
                            .build())
                    .build();
            return stub.withDeadlineAfter(WRITE_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .reserveQuota(request);
        } catch (StatusRuntimeException e) {
            throw mapGrpcStatusForReserve(e, ticketId);
        }
    }

    /**
     * Releases a previously created reservation (compensation path).
     *
     * Called when the DB transaction fails after a successful {@link #reserveQuota} so
     * that inventory is returned to ticket-service immediately rather than waiting for
     * expiry.  This call is best-effort: if it fails, the expiry worker will clean up.
     *
     * @param reservationId the reservation to release
     * @param reason        human-readable reason (e.g. "COMPENSATION")
     */
    public void releaseReservation(UUID reservationId, String reason) {
        try {
            ReleaseReservationRequest request = ReleaseReservationRequest.newBuilder()
                    .setReservationId(reservationId.toString())
                    .setReason(reason)
                    .build();
            stub.withDeadlineAfter(WRITE_DEADLINE_SECONDS, TimeUnit.SECONDS)
                    .releaseReservation(request);
            log.info("Compensation release succeeded reservationId={}", reservationId);
        } catch (StatusRuntimeException e) {
            // Best-effort: log at WARN so an alert fires, but do not surface to the caller.
            log.warn("Compensation release failed for reservationId={}: gRPC status={}",
                    reservationId, e.getStatus(), e);
        } catch (Exception e) {
            log.warn("Compensation release failed for reservationId={}: {}", reservationId, e.getMessage(), e);
        }
    }

    // ── gRPC status code mapping ───────────────────────────────────────────────

    /**
     * Maps a gRPC {@link StatusRuntimeException} to the appropriate Spring HTTP exception.
     * Ensures callers receive accurate HTTP status codes (R-13) rather than a blanket 400.
     */
    private RuntimeException mapGrpcStatus(StatusRuntimeException e, String ticketId) {
        Status.Code code = e.getStatus().getCode();
        String description = e.getStatus().getDescription();
        log.error("gRPC call to ticket-service failed: status={} ticketId={}", e.getStatus(), ticketId, e);
        return switch (code) {
            case NOT_FOUND ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Ticket not found: " + ticketId);
            case INVALID_ARGUMENT ->
                new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Invalid request: " + description);
            case UNAUTHENTICATED ->
                new ResponseStatusException(HttpStatus.UNAUTHORIZED,
                        "Unauthenticated: " + description);
            case PERMISSION_DENIED ->
                new ResponseStatusException(HttpStatus.FORBIDDEN,
                        "Permission denied: " + description);
            case UNAVAILABLE, DEADLINE_EXCEEDED ->
                new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "Ticket service is temporarily unavailable. Please try again shortly.");
            case RESOURCE_EXHAUSTED ->
                new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                        "Rate limit exceeded. Please try again shortly.");
            default ->
                new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                        "An unexpected error occurred while contacting ticket-service.");
        };
    }

    private RuntimeException mapGrpcStatusForReserve(StatusRuntimeException e, String ticketId) {
        Status.Code code = e.getStatus().getCode();
        String description = e.getStatus().getDescription();
        log.error("ReserveQuota gRPC call failed: status={} ticketId={}", e.getStatus(), ticketId, e);
        return switch (code) {
            case NOT_FOUND ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Ticket not found: " + ticketId);
            case INVALID_ARGUMENT ->
                new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Invalid reserve request: " + description);
            case RESOURCE_EXHAUSTED ->
                // Sold-out or quota exceeded
                new ResponseStatusException(HttpStatus.CONFLICT,
                        "Ticket is sold out or quota exceeded: " + ticketId);
            case FAILED_PRECONDITION ->
                // Per-user purchase limit exceeded
                new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Purchase limit exceeded for this ticket");
            case UNAVAILABLE, DEADLINE_EXCEEDED ->
                new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "Ticket service is temporarily unavailable. Please try again shortly.");
            default ->
                new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                        "An unexpected error occurred while reserving ticket quota.");
        };
    }

    // ── Circuit-breaker fallbacks ─────────────────────────────────────────────

    /**
     * Fallback invoked when the circuit breaker is OPEN or when validateAvailability
     * throws an exception that matches the circuit breaker's recordExceptions list.
     */
    @SuppressWarnings("unused")
    private ValidateTicketResponse validateAvailabilityFallback(
            String ticketId, CallNotPermittedException ex) {
        log.warn("Circuit breaker OPEN for ticket-service — rejecting order for ticketId={}", ticketId);
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Ticket service is temporarily unavailable. Please try again shortly.");
    }

    @SuppressWarnings("unused")
    private ValidateTicketResponse validateAvailabilityFallback(
            String ticketId, Throwable ex) {
        // ResponseStatusException means the gRPC error was already translated to a valid HTTP
        // response (e.g. 404, 409) — re-throw unchanged rather than overwriting with 503.
        if (ex instanceof ResponseStatusException rse) {
            throw rse;
        }
        log.warn("Circuit breaker fallback for ticket-service: ticketId={} reason={}", ticketId, ex.getMessage());
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Ticket service is temporarily unavailable. Please try again shortly.");
    }

    @SuppressWarnings("unused")
    private ReserveQuotaResponse reserveQuotaFallback(
            String ticketId, UUID reservationId, UUID userId, int quantity, Instant expiresAt,
            CallNotPermittedException ex) {
        log.warn("Circuit breaker OPEN for ticket-service — rejecting reserveQuota ticketId={}", ticketId);
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Ticket service is temporarily unavailable. Please try again shortly.");
    }

    @SuppressWarnings("unused")
    private ReserveQuotaResponse reserveQuotaFallback(
            String ticketId, UUID reservationId, UUID userId, int quantity, Instant expiresAt,
            Throwable ex) {
        // ResponseStatusException means the gRPC error was already translated to a valid HTTP
        // response (e.g. 404, 409) — re-throw unchanged rather than overwriting with 503.
        if (ex instanceof ResponseStatusException rse) {
            throw rse;
        }
        log.warn("Circuit breaker fallback for reserveQuota: ticketId={} reason={}", ticketId, ex.getMessage());
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Ticket service is temporarily unavailable. Please try again shortly.");
    }
}
