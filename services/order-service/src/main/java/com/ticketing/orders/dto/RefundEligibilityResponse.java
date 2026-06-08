package com.ticketing.orders.dto;

import java.util.UUID;

public record RefundEligibilityResponse(
        UUID orderId,
        boolean eligible,
        String reason,
        int refundableAmount,
        String cutoffAt
) {}
