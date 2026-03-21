package com.ticketing.orders.grpc;

import io.grpc.StatusRuntimeException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.TimeUnit;

/**
 * Thin wrapper around the gRPC stub — applies deadlines and maps gRPC errors to
 * application exceptions. Keeps gRPC concerns out of the service layer.
 */
@Component
public class TicketServiceClient {

    private static final Logger log = LoggerFactory.getLogger(TicketServiceClient.class);
    private static final int READ_DEADLINE_SECONDS = 5;

    private final TicketServiceGrpc.TicketServiceBlockingStub stub;

    public TicketServiceClient(TicketServiceGrpc.TicketServiceBlockingStub stub) {
        this.stub = stub;
    }

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
            log.error("gRPC call to ticket-service failed: status={} ticketId={}", e.getStatus(), ticketId, e);
            throw new com.ticketing.orders.exception.BadRequestException(
                    "Unable to validate ticket: " + e.getStatus().getDescription());
        }
    }
}
