package com.ticketing.orders.dto;

import jakarta.validation.constraints.NotBlank;
import java.util.UUID;

public class CreateOrderRequest {

    @NotBlank(message = "ticketId is required")
    private String ticketId;

    public UUID getTicketId() {
        return UUID.fromString(ticketId);
    }

    public void setTicketId(String ticketId) {
        this.ticketId = ticketId;
    }
}
