package com.ticketing.orders.dto;

import com.ticketing.orders.entity.OrderType;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;

public class CreateOrderRequest {

    private static final String UUID_PATTERN =
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

    @NotBlank(message = "ticketId is required")
    @Pattern(
            regexp = UUID_PATTERN,
            message = "ticketId must be a valid UUID (lowercase hex, e.g. 550e8400-e29b-41d4-a716-446655440000)")
    private String ticketId;

    /** Number of units to purchase. Defaults to 1 when omitted by the client. */
    @Min(value = 1, message = "quantity must be at least 1")
    private int quantity = 1;

    /** Optional: specific seat IDs the client has held (MANUAL_SEATED flow). */
    @Size(max = 50, message = "seatIds list must not exceed 50 entries")
    private List<@Pattern(regexp = UUID_PATTERN, message = "each seatId must be a valid UUID") String> seatIds;

    /** Optional: section UUID for auto-assign flow (AUTO_ASSIGN_SEATED). */
    @Pattern(
            regexp = UUID_PATTERN,
            message = "sectionId must be a valid UUID")
    private String sectionId;

    /** Optional: seating plan UUID — required for both seated flows. */
    @Pattern(
            regexp = UUID_PATTERN,
            message = "planId must be a valid UUID")
    private String planId;

    /** Optional: per-seat attendee info. Validated when present. */
    @Valid
    private List<AttendeeInfo> attendees;

    // ── nested record ─────────────────────────────────────────────────────────

    public static class AttendeeInfo {

        @NotBlank(message = "attendee seatId is required")
        @Pattern(regexp = UUID_PATTERN, message = "attendee seatId must be a valid UUID")
        private String seatId;

        @NotBlank(message = "attendee name is required")
        private String name;

        public AttendeeInfo() {}

        public String getSeatId() { return seatId; }
        public void setSeatId(String seatId) { this.seatId = seatId; }
        public String getName() { return name; }
        public void setName(String name) { this.name = name; }
    }

    // ── order type resolution ─────────────────────────────────────────────────

    /**
     * Derives the order type from the combination of optional seated fields.
     *
     * <ul>
     *   <li>MANUAL_SEATED — {@code seatIds} is non-null and non-empty</li>
     *   <li>AUTO_ASSIGN_SEATED — {@code sectionId} is non-null</li>
     *   <li>GA — neither of the above</li>
     * </ul>
     */
    public OrderType determineOrderType() {
        if (seatIds != null && !seatIds.isEmpty()) {
            return OrderType.MANUAL_SEATED;
        }
        if (sectionId != null) {
            return OrderType.AUTO_ASSIGN_SEATED;
        }
        return OrderType.GA;
    }

    /**
     * Cross-field validation for the seated and GA paths.
     *
     * @throws IllegalArgumentException if the request is semantically invalid
     */
    public void validate() {
        validateAttendees();
        
        OrderType orderType = determineOrderType();
        switch (orderType) {
            case MANUAL_SEATED:
                if (quantity != seatIds.size()) {
                    throw new IllegalArgumentException(
                            "quantity (" + quantity + ") must equal the number of seatIds (" + seatIds.size() + ")");
                }
                break;
            case AUTO_ASSIGN_SEATED:
                if (quantity < 1) {
                    throw new IllegalArgumentException("quantity must be at least 1");
                }
                if (sectionId == null) {
                    throw new IllegalArgumentException("sectionId is required for AUTO_ASSIGN_SEATED");
                }
                if (planId == null) {
                    throw new IllegalArgumentException("planId is required for AUTO_ASSIGN_SEATED");
                }
                break;
            case GA:
                if (quantity < 1) {
                    throw new IllegalArgumentException("quantity must be at least 1");
                }
                break;
            default:
                break;
        }
    }

    /**
     * Validates nested attendee objects. Ensures that if attendees are present,
     * each has a non-blank, valid-UUID seatId and non-blank name.
     *
     * @throws IllegalArgumentException if any attendee has null or blank seatId/name, or invalid UUID format
     */
    private void validateAttendees() {
        if (attendees == null || attendees.isEmpty()) {
            return;
        }
        for (int i = 0; i < attendees.size(); i++) {
            AttendeeInfo attendee = attendees.get(i);
            if (attendee.seatId == null || attendee.seatId.isBlank()) {
                throw new IllegalArgumentException("attendee[" + i + "].seatId is required and must not be blank");
            }
            if (!attendee.seatId.matches(UUID_PATTERN)) {
                throw new IllegalArgumentException("attendee[" + i + "].seatId must be a valid UUID");
            }
            if (attendee.name == null || attendee.name.isBlank()) {
                throw new IllegalArgumentException("attendee[" + i + "].name is required and must not be blank");
            }
        }
    }

    // ── accessors ─────────────────────────────────────────────────────────────

    public java.util.UUID getTicketId() {
        return java.util.UUID.fromString(ticketId);
    }

    public void setTicketId(String ticketId) {
        this.ticketId = ticketId;
    }

    public int getQuantity() { return quantity; }
    public void setQuantity(int quantity) { this.quantity = quantity; }

    public List<String> getSeatIds() { return seatIds; }
    public void setSeatIds(List<String> seatIds) { this.seatIds = seatIds; }

    public String getSectionId() { return sectionId; }
    public void setSectionId(String sectionId) { this.sectionId = sectionId; }

    public String getPlanId() { return planId; }
    public void setPlanId(String planId) { this.planId = planId; }

    public List<AttendeeInfo> getAttendees() { return attendees; }
    public void setAttendees(List<AttendeeInfo> attendees) { this.attendees = attendees; }
}
