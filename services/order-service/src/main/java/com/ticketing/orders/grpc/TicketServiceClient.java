package com.ticketing.orders.grpc;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

import java.util.concurrent.TimeUnit;

/**
 * Thin wrapper around the gRPC stub — applies deadlines, a circuit breaker, and maps
 * gRPC errors to application exceptions.  Keeps gRPC concerns out of the service layer.
 *
 * Circuit breaker (R-01): when ticket-service is unreachable the circuit opens after
 * 50 % of 10 calls fail.  While open, {@link #validateAvailabilityFallback} is called
 * immediately (no 5-second deadline wait per request), returning a clear error to the
 * caller without cascading load onto order-service threads.
 *
 * Status mapping (R-13): gRPC status codes are translated to the appropriate HTTP
 * status codes rather than collapsing all errors into 400.
 */
@Component
public class TicketServiceClient {

    private static final Logger log = LoggerFactory.getLogger(TicketServiceClient.class);
    private static final int READ_DEADLINE_SECONDS = 5;

    private final TicketServiceGrpc.TicketServiceBlockingStub stub;

    public TicketServiceClient(TicketServiceGrpc.TicketServiceBlockingStub stub) {
        this.stub = stub;
    }

    /**
     * Validates that the ticket exists and is available for purchase.
     *
     * Protected by the "ticketService" circuit breaker defined in application.yml.
     * On open circuit, {@link #validateAvailabilityFallback} is invoked instead.
     */
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

    /**
     * Fallback invoked when the circuit breaker is OPEN or when validateAvailability
     * throws an exception that matches the circuit breaker's recordExceptions list.
     *
     * We do NOT silently succeed — that would allow orders against unavailable tickets.
     * Instead we surface a clear SERVICE_UNAVAILABLE error to the client.
     */
    @SuppressWarnings("unused") // invoked reflectively by resilience4j
    private ValidateTicketResponse validateAvailabilityFallback(
            String ticketId, CallNotPermittedException ex) {
        log.warn("Circuit breaker OPEN for ticket-service — rejecting order for ticketId={}", ticketId);
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Ticket service is temporarily unavailable. Please try again shortly.");
    }

    /**
     * Fallback for any other recorded exception (e.g. StatusRuntimeException that
     * trips the circuit).  Resilience4j requires a fallback per exception type.
     */
    @SuppressWarnings("unused")
    private ValidateTicketResponse validateAvailabilityFallback(
            String ticketId, Throwable ex) {
        log.warn("Circuit breaker fallback for ticket-service: ticketId={} reason={}", ticketId, ex.getMessage());
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Ticket service is temporarily unavailable. Please try again shortly.");
    }
}
