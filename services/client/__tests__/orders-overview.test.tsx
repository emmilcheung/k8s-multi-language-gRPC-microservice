import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrdersOverview } from "@/components/orders/orders-overview";

describe("OrdersOverview", () => {
  it("shows the empty upcoming state and lets the buyer switch to past orders", async () => {
    const user = userEvent.setup();

    render(
      <OrdersOverview
        orders={[
          {
            id: "order-past-1",
            userId: "buyer-1",
            status: "complete",
            quantity: 2,
            expiresAt: "2026-05-27T11:30:00.000Z",
            ticket: {
              id: "ticket-1",
              title: "Phoenix",
              price: "64.00",
            },
            version: 0,
            event: {
              title: "Phoenix",
              startsAt: "2026-05-20T20:00:00.000Z",
              venueName: "Greek Theatre",
            },
          },
        ]}
      />
    );

    expect(screen.getByRole("heading", { level: 2, name: /no upcoming orders/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /browse tonight's shows/i })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /past/i }));

    expect(screen.getByText("Phoenix")).toBeInTheDocument();
    expect(screen.getByText(/greek theatre/i)).toBeInTheDocument();
  });

  it("falls back to the ticket title when the enriched event title is blank", async () => {
    const user = userEvent.setup();

    render(
      <OrdersOverview
        orders={[
          {
            id: "order-past-2",
            userId: "buyer-2",
            status: "created",
            quantity: 1,
            expiresAt: "2026-05-27T11:30:00.000Z",
            ticket: {
              id: "ticket-2",
              title: "Order fallback title",
              price: "55.00",
            },
            version: 0,
            event: {
              title: "",
              startsAt: "2026-05-20T20:00:00.000Z",
              venueName: "Fallback Hall",
            },
          },
        ]}
      />
    );

    await user.click(screen.getByRole("tab", { name: /past/i }));

    expect(screen.getByRole("heading", { level: 3, name: /order fallback title/i })).toBeInTheDocument();
  });

  it("switches to the saved tab from the empty-state CTA", async () => {
    const user = userEvent.setup();

    render(<OrdersOverview orders={[]} savedEvents={[]} />);

    expect(screen.getByRole("tab", { name: /upcoming/i })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: /view saved events/i }));

    expect(screen.getByRole("tab", { name: /saved/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/no saved events yet/i)).toBeInTheDocument();
  });
});
