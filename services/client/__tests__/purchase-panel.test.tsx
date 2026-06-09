import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PurchasePanel } from "@/app/tickets/[ticketId]/_components/purchase-panel";
import type { Ticket } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-1",
    title: "Phoenix",
    price: "48.00",
    userId: "owner-1",
    version: 1,
    available: 120,
    ticketType: "SEATED_MANUAL",
    event: {
      title: "Phoenix",
      startsAt: "2099-08-09T20:30:00Z",
      venueName: "Greek Theatre",
    },
    ...overrides,
  };
}

describe("PurchasePanel", () => {
  it("renders redesigned seated right-rail actions and trust strip", () => {
    render(
      <PurchasePanel
        ticket={makeTicket()}
        isSeated
        gaMaxQuantity={6}
        purchaseGate={null}
      />
    );

    expect(screen.getAllByRole("link", { name: /continue to seat map/i })[0]).toHaveAttribute("href", "/tickets/ticket-1/seats");
    expect(screen.getByText(/mobile entry/i)).toBeInTheDocument();
    expect(screen.getByText(/transferable/i)).toBeInTheDocument();
    expect(screen.getByText(/refund-protected/i)).toBeInTheDocument();
  });
});
