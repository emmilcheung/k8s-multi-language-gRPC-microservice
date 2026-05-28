import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketForm } from "@/components/ticket-form";
import type { TicketState } from "@/app/actions/tickets";

describe("TicketForm", () => {
  it("renders modern creator entry heading on ticket-type step", () => {
    const action = vi.fn(async (prev: TicketState, formData: FormData): Promise<TicketState> => {
      void prev;
      void formData;
      return {};
    });

    render(<TicketForm action={action} />);

    expect(
      screen.getByRole("heading", { name: /create your event listing/i })
    ).toBeInTheDocument();
  });

  it("shows organizer-style setup rails after choosing a ticket type", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (prev: TicketState, formData: FormData): Promise<TicketState> => {
      void prev;
      void formData;
      return {};
    });

    render(<TicketForm action={action} />);

    await user.click(screen.getByRole("button", { name: /general admission/i }));

    expect(screen.getByText(/^setup$/i)).toBeInTheDocument();
    expect(screen.getByText(/step 3 of 9/i)).toBeInTheDocument();
    expect(screen.getByText(/live preview/i)).toBeInTheDocument();
    expect(screen.getAllByText(/seating plan/i).length).toBeGreaterThan(0);
  });

  it("renders defaults and submits edited values", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (prev: TicketState, formData: FormData): Promise<TicketState> => {
      void prev;
      void formData;
      return {};
    });

    render(
      <TicketForm
        action={action}
        defaultTitle="Rock Concert"
        defaultPrice={49.99}
        defaultTicketType="GA"
        submitLabel="Update Ticket"
      />
    );

    const titleInput = screen.getByLabelText(/title/i);
    const priceInput = screen.getByLabelText(/price/i);

    expect(titleInput).toHaveValue("Rock Concert");
    expect(priceInput).toHaveValue(49.99);

    await user.clear(titleInput);
    await user.type(titleInput, "Jazz Night");
    await user.clear(priceInput);
    await user.type(priceInput, "25.50");
    await user.click(screen.getByLabelText(/require qr admission/i));
    await user.click(screen.getByRole("button", { name: /update ticket/i }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const [, formData] = action.mock.calls[0] as [TicketState, FormData];
    expect(formData.get("title")).toBe("Jazz Night");
    expect(formData.get("price")).toBe("25.5");
    expect(formData.get("requireQrForEntry")).toBe("false");
  });

  it("locks attendance requirement toggle when attendance changes are disabled", async () => {
    const action = vi.fn(async (prev: TicketState, formData: FormData): Promise<TicketState> => {
      void prev;
      void formData;
      return {};
    });

    render(
      <TicketForm
        action={action}
        defaultTitle="Sold Event"
        defaultPrice={30}
        defaultTicketType="GA"
        defaultRequireQrForEntry
        attendanceLocked
        submitLabel="Update Ticket"
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText(/require qr admission/i)).toBeDisabled();
    });
  });

  it("reloads the current page after a successful same-page update", async () => {
    const reloadMock = vi.fn();
    vi.stubGlobal("location", { reload: reloadMock });

    const user = userEvent.setup();
    const action = vi.fn(async (prev: TicketState, formData: FormData): Promise<TicketState> => {
      void prev;
      void formData;
      return { refreshed: true };
    });

    render(
      <TicketForm
        action={action}
        defaultTitle="Reload Test"
        defaultPrice={15}
        defaultTicketType="GA"
        submitLabel="Update Ticket"
      />
    );

    await user.click(screen.getByRole("button", { name: /update ticket/i }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });
});
