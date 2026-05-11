import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
  beforeEach(() => {
    // Clear sessionStorage between tests so device IDs don't bleed over.
    sessionStorage.clear();
  });

  it("generates a stable per-session deviceId prefixed with the gate label", async () => {
    render(<ScannerClient eventId="event-1" />);

    // deviceId should be visible (even if small/de-emphasized)
    const idEl = screen.getByTestId("scanner-device-id");
    expect(idEl.textContent).toMatch(/^gate-GATE-[0-9a-f-]{36}$/);

    // Second render in the same sessionStorage scope reuses the same id
    cleanup();
    render(<ScannerClient eventId="event-1" />);
    const idEl2 = screen.getByTestId("scanner-device-id");
    expect(idEl2.textContent).toBe(idEl.textContent);
  });

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
    expect(scanCheckInMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token",
        eventId: "event-1",
        deviceId: expect.stringMatching(/^gate-GATE-[0-9a-f-]{36}$/),
      })
    );
    expect(screen.getByText(/checked in/i)).toBeInTheDocument();
  });

  it("supports fallback check-in by buyer email", async () => {
    scanCheckInByEmailMock.mockResolvedValue({ result: "valid", status: "USED" });
    const user = userEvent.setup();
    render(<ScannerClient eventId="event-1" />);

    await user.type(screen.getByLabelText(/buyer email/i), "buyer@example.com");
    await user.click(screen.getByRole("button", { name: /check in by email/i }));

    await waitFor(() => expect(scanCheckInByEmailMock).toHaveBeenCalledTimes(1));
    expect(scanCheckInByEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "event-1",
        email: "buyer@example.com",
        deviceId: expect.stringMatching(/^gate-GATE-[0-9a-f-]{36}$/),
      })
    );
  });
});
