package com.ticketing.orders.dto;

import java.math.BigDecimal;
import java.util.UUID;

public record SeatSummary(
        UUID seatId,
        UUID sectionId,
        String seatLabel,
        BigDecimal price
) {}
