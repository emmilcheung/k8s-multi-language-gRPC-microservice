// __tests__/purchase-button.test.tsx — Component tests for PurchaseButton.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PurchaseButton } from "@/components/purchase-button";
import type { OrderState } from "@/app/actions/orders";

let mockState: OrderState = {};
let mockPending = false;
const mockFormAction = vi.fn();

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useActionState: (_action: unknown, _initialState: unknown) => [
      mockState,
      mockFormAction,
      mockPending,
    ],
  };
});

// createOrder is imported inside the component — mock it.
vi.mock("@/app/actions/orders", () => ({
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  submitPayment: vi.fn(),
}));

describe("PurchaseButton", () => {
  beforeEach(() => {
    mockState = {};
    mockPending = false;
    mockFormAction.mockClear();
  });

  it("renders the Purchase button", () => {
    render(<PurchaseButton ticketId="ticket-123" />);
    expect(screen.getByRole("button", { name: /purchase/i })).toBeInTheDocument();
  });

  it("shows Processing label when pending", () => {
    mockPending = true;
    render(<PurchaseButton ticketId="ticket-123" />);
    expect(screen.getByRole("button", { name: /processing/i })).toBeDisabled();
  });

  it("shows error alert when state.error is set", () => {
    mockState = { error: "Ticket already reserved." };
    render(<PurchaseButton ticketId="ticket-123" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Ticket already reserved.");
  });

  it("does not render an alert when there is no error", () => {
    render(<PurchaseButton ticketId="ticket-123" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
