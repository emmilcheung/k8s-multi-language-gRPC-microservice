import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PurchaseButton } from "@/components/purchase-button";

describe("PurchaseButton", () => {
  it("renders purchase CTA", () => {
    render(<PurchaseButton ticketId="ticket-123" />);
    expect(screen.getByRole("button", { name: /purchase ticket/i })).toBeInTheDocument();
  });
});
