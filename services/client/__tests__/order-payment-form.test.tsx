import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrderPaymentForm } from "@/components/order-payment-form";

describe("OrderPaymentForm", () => {
  it("renders amount and action buttons", () => {
    render(
      <OrderPaymentForm
        orderId="ord-1"
        amount={25.5}
        expiresAt="2099-12-31T23:59:59.000Z"
      />
    );

    expect(screen.getByText("$25.50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pay now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel order/i })).toBeInTheDocument();
  });
});
