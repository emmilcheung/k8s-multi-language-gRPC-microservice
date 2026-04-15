import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketForm } from "@/components/ticket-form";
import type { TicketState } from "@/app/actions/tickets";

describe("TicketForm", () => {
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
    await user.click(screen.getByRole("button", { name: /update ticket/i }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const [, formData] = action.mock.calls[0] as [TicketState, FormData];
    expect(formData.get("title")).toBe("Jazz Night");
    expect(formData.get("price")).toBe("25.5");
  });
});
