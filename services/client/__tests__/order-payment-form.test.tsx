import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { OrderPaymentForm } from "@/components/order-payment-form";

describe("OrderPaymentForm", () => {
  afterEach(() => {
    delete (window as Window & { Stripe?: unknown }).Stripe;
    vi.restoreAllMocks();
  });

  it("renders amount and action buttons", () => {
    const { container } = render(
      <OrderPaymentForm
        orderId="ord-1"
        amount={25.5}
        expiresAt="2099-12-31T23:59:59.000Z"
      />
    );

    expect(screen.getByText("$25.50")).toBeInTheDocument();
    expect(screen.getByText(/^Card Details$/i)).toBeInTheDocument();
    expect(screen.getByText(/loading payment form/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pay now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel order/i })).toBeInTheDocument();
    expect(container.querySelector("#card-element")).not.toBeNull();
  });

  it("mounts the Stripe card element when Stripe is ready", async () => {
    const originalPublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_mock";

    Object.defineProperty(window, "Stripe", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        elements: () => ({
          create: () => ({
            mount(container: HTMLElement | string) {
              const target =
                typeof container === "string"
                  ? document.querySelector(container)
                  : container;

              if (target instanceof HTMLElement) {
                target.setAttribute("data-stripe-mock", "mounted");
              }
            },
            unmount() {},
          }),
        }),
        createPaymentMethod: vi.fn(),
      })),
    });

    const { container } = render(
      <OrderPaymentForm
        orderId="ord-1"
        amount={25.5}
        expiresAt="2099-12-31T23:59:59.000Z"
      />
    );

    try {
      await waitFor(() => {
        expect(container.querySelector("#card-element")?.getAttribute("data-stripe-mock")).toBe(
          "mounted"
        );
      });

      await waitFor(() => {
        expect(screen.queryByText(/loading payment form/i)).not.toBeInTheDocument();
        expect(screen.getByText(/please complete your card details, including cvc/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /pay now/i })).toBeDisabled();
      });
    } finally {
      if (originalPublishableKey === undefined) {
        delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = originalPublishableKey;
      }
    }
  });

  it("enables Pay Now after card element reports complete", async () => {
    const originalPublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_mock";

    let changeHandler: ((event: { error?: { message?: string }; complete: boolean }) => void) | null = null;

    Object.defineProperty(window, "Stripe", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        elements: () => ({
          create: () => ({
            mount(container: HTMLElement | string) {
              const target =
                typeof container === "string"
                  ? document.querySelector(container)
                  : container;
              if (target instanceof HTMLElement) {
                target.setAttribute("data-stripe-mock", "mounted");
              }
            },
            unmount() {},
            on(_event: string, handler: (event: { error?: { message?: string }; complete: boolean }) => void) {
              changeHandler = handler;
            },
            off() {},
          }),
        }),
        createPaymentMethod: vi.fn(),
      })),
    });

    render(
      <OrderPaymentForm
        orderId="ord-1"
        amount={25.5}
        expiresAt="2099-12-31T23:59:59.000Z"
      />
    );

    try {
      // Wait for Stripe to mount
      await waitFor(() => {
        expect(screen.queryByText(/loading payment form/i)).not.toBeInTheDocument();
      });

      // Button should be disabled before card is complete
      expect(screen.getByRole("button", { name: /pay now/i })).toBeDisabled();
      expect(screen.getByText(/please complete your card details, including cvc/i)).toBeInTheDocument();

      // Simulate card completion
      const { act } = await import("@testing-library/react");
      await act(async () => {
        changeHandler?.({ complete: true });
      });

      // Button should now be enabled and hint should disappear
      expect(screen.getByRole("button", { name: /pay now/i })).toBeEnabled();
      expect(screen.queryByText(/please complete your card details, including cvc/i)).not.toBeInTheDocument();
    } finally {
      if (originalPublishableKey === undefined) {
        delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = originalPublishableKey;
      }
    }
  });
});
