// __tests__/order-payment-form.test.tsx — Component tests for OrderPaymentForm.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrderPaymentForm } from "@/components/order-payment-form";
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

vi.mock("@/app/actions/orders", () => ({
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  submitPayment: vi.fn(),
}));

const EXPIRES = "2099-12-31T23:59:59.000Z";

describe("OrderPaymentForm", () => {
  beforeEach(() => {
    mockState = {};
    mockPending = false;
    mockFormAction.mockClear();
  });

  it("renders the amount", () => {
    render(<OrderPaymentForm orderId="ord-1" amount={25.5} expiresAt={EXPIRES} />);
    expect(screen.getByText("$25.50")).toBeInTheDocument();
  });

  it("renders Pay Now button", () => {
    render(<OrderPaymentForm orderId="ord-1" amount={10} expiresAt={EXPIRES} />);
    expect(screen.getByRole("button", { name: /pay now/i })).toBeInTheDocument();
  });

  it("renders Cancel Order button", () => {
    render(<OrderPaymentForm orderId="ord-1" amount={10} expiresAt={EXPIRES} />);
    expect(screen.getByRole("button", { name: /cancel order/i })).toBeInTheDocument();
  });

  it("shows error alert when state.error is set", () => {
    mockState = { error: "Payment failed." };
    render(<OrderPaymentForm orderId="ord-1" amount={10} expiresAt={EXPIRES} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Payment failed.");
  });

  it("disables both buttons when pending", () => {
    mockPending = true;
    render(<OrderPaymentForm orderId="ord-1" amount={10} expiresAt={EXPIRES} />);
    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });
});
