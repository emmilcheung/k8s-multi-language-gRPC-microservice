package com.ticketing.orders.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;

public class CreateOrderRequest {

    private static final String UUID_PATTERN =
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

    @NotBlank(message = "ticketId is required")
    @Pattern(regexp = UUID_PATTERN, message = "ticketId must be a valid UUID (lowercase hex, e.g. 550e8400-e29b-41d4-a716-446655440000)")
    private String ticketId;

    public UUID getTicketId() {
        return UUID.fromString(ticketId);
    }

    public void setTicketId(String ticketId) {
        this.ticketId = ticketId;
    }
}
