import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScannerClient } from "@/components/scanner-client";

const scanCheckInMock = vi.fn();
const scanCheckInByEmailMock = vi.fn();

vi.mock("@/app/actions/attendance", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/attendance")>("@/app/actions/attendance");
  return {
    ...actual,
    scanCheckIn: (...args: unknown[]) => scanCheckInMock(...args),
    scanCheckInByEmail: (...args: unknown[]) => scanCheckInByEmailMock(...args),
  };
});

describe("ScannerClient", () => {
  it("uses check-in only flow and shows checked-in copy on success", async () => {
    scanCheckInMock.mockResolvedValue({ result: "valid", status: "USED" });
    const user = userEvent.setup();
    render(<ScannerClient eventId="event-1" />);

    expect(screen.queryByRole("button", { name: /validate/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start camera scan/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/qr token/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /enter token manually/i }));
    await user.type(screen.getByLabelText(/qr token/i), "token");
    await user.click(screen.getByRole("button", { name: /check in attendee/i }));

    await waitFor(() => expect(scanCheckInMock).toHaveBeenCalledTimes(1));
    expect(scanCheckInMock).toHaveBeenCalledWith({
      token: "token",
      eventId: "event-1",
      deviceId: "scanner-web-local",
    });
    expect(screen.getByText(/checked in/i)).toBeInTheDocument();
  });

  it("supports fallback check-in by buyer email", async () => {
    scanCheckInByEmailMock.mockResolvedValue({ result: "valid", status: "USED" });
    const user = userEvent.setup();
    render(<ScannerClient eventId="event-1" />);

    await user.type(screen.getByLabelText(/buyer email/i), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: /check in by email/i }));

    await waitFor(() => expect(scanCheckInByEmailMock).toHaveBeenCalledTimes(1));
    expect(scanCheckInByEmailMock).toHaveBeenCalledWith({
      eventId: "event-1",
      email: "buyer@example.com",
      deviceId: "scanner-web-local",
    });
  });
});
