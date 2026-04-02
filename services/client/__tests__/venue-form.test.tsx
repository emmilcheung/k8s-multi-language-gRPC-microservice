import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VenueForm } from "@/components/venue-form";
import type { VenueState } from "@/app/actions/venues";

describe("VenueForm", () => {
  it("renders all required fields", () => {
    const action = vi.fn(async (_prev: VenueState, _fd: FormData): Promise<VenueState> => ({}));
    render(<VenueForm action={action} />);

    expect(screen.getByLabelText(/venue name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/total capacity/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/timezone/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create venue/i })).toBeInTheDocument();
  });

  it("submits with user-entered values", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (_prev: VenueState, _fd: FormData): Promise<VenueState> => ({}));
    render(<VenueForm action={action} />);

    await user.type(screen.getByLabelText(/venue name/i), "Madison Square Garden");
    await user.clear(screen.getByLabelText(/total capacity/i));
    await user.type(screen.getByLabelText(/total capacity/i), "20000");
    await user.clear(screen.getByLabelText(/timezone/i));
    await user.type(screen.getByLabelText(/timezone/i), "America/New_York");
    await user.click(screen.getByRole("button", { name: /create venue/i }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const [, formData] = action.mock.calls[0] as [VenueState, FormData];
    expect(formData.get("name")).toBe("Madison Square Garden");
    expect(formData.get("capacity")).toBe("20000");
    expect(formData.get("timezone")).toBe("America/New_York");
  });

  it("shows an error alert when state contains an error", () => {
    const action = vi.fn(async (_prev: VenueState, _fd: FormData): Promise<VenueState> => ({
      error: "Venue name is required.",
    }));
    render(<VenueForm action={action} />);
    // No error initially
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
