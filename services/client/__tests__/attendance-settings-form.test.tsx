import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttendanceSettingsForm } from "@/components/attendance-settings-form";

const updateAttendancePolicyMock = vi.fn();
vi.mock("@/app/actions/attendance-policy", () => ({
  updateAttendancePolicyAction: (...args: unknown[]) => updateAttendancePolicyMock(...args),
}));

describe("AttendanceSettingsForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits updated policy values via server action", async () => {
    const user = userEvent.setup();
    updateAttendancePolicyMock.mockResolvedValue({
      policy: {
        eventId: "ticket-1",
        requireQrForEntry: false,
        allowManualOverride: true,
      },
    });

    render(
      <AttendanceSettingsForm
        eventId="ticket-1"
        initialSettings={{
          eventId: "ticket-1",
          requireQrForEntry: true,
          allowManualOverride: false,
        }}
        summary={{
          eventId: "ticket-1",
          totalAdmitted: 12,
          totalDenied: 1,
          totalCheckedIn: 12,
        }}
      />
    );

    await user.click(screen.getByLabelText(/require qr for entry/i));
    await user.click(screen.getByLabelText(/allow manual override/i));
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(updateAttendancePolicyMock).toHaveBeenCalledTimes(1));
    expect(updateAttendancePolicyMock).toHaveBeenCalledWith("ticket-1", {
      requireQrForEntry: false,
      allowManualOverride: true,
    });
    expect(screen.getByText(/12 admitted/i)).toBeInTheDocument();
    expect(screen.getByText(/1 denied/i)).toBeInTheDocument();
  });

  it("disables policy changes when attendance is locked", () => {
    render(
      <AttendanceSettingsForm
        eventId="ticket-1"
        initialSettings={{
          eventId: "ticket-1",
          requireQrForEntry: true,
          allowManualOverride: false,
        }}
        locked
      />
    );

    expect(screen.getByLabelText(/require qr for entry/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
  });

  it("renders checked-in attendees with email fallback to user id", () => {
    render(
      <AttendanceSettingsForm
        eventId="ticket-1"
        initialSettings={{
          eventId: "ticket-1",
          requireQrForEntry: true,
          allowManualOverride: false,
        }}
        checkIns={[
          {
            credentialId: "cred-1",
            ticketId: "ticket-1",
            orderId: "order-1",
            eventId: "ticket-1",
            status: "USED",
            buyerUserId: "buyer-1",
            checkedInAt: "2026-12-01T10:00:00Z",
          },
          {
            credentialId: "cred-2",
            ticketId: "ticket-1",
            orderId: "order-2",
            eventId: "ticket-1",
            status: "USED",
            buyerUserId: "buyer-2",
          },
        ]}
        buyerEmailsByUserID={{
          "buyer-1": "buyer1@example.com",
        }}
      />
    );

    expect(screen.getByText(/checked-in attendees/i)).toBeInTheDocument();
    expect(screen.getByText(/buyer1@example.com/i)).toBeInTheDocument();
    expect(screen.getByText(/buyer-2/i)).toBeInTheDocument();
  });
});
