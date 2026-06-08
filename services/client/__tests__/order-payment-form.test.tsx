import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { OrderPaymentForm } from "@/components/order-payment-form";

// Module-level mock for router.refresh so we can assert it from tests
const routerRefreshMock = vi.fn();
const submitPaymentMock = vi.fn();

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
  }),
}));

vi.mock("@/app/actions/orders", () => ({
  cancelOrder: vi.fn(),
  submitPayment: (...args: unknown[]) => submitPaymentMock(...args),
}));

describe("OrderPaymentForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    submitPaymentMock.mockResolvedValue({});
  });

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
    expect(screen.getByRole("link", { name: /send to friend instead/i })).toHaveAttribute(
      "href",
      "/orders/ord-1/transfer"
    );
    expect(screen.getByRole("link", { name: /request refund/i })).toHaveAttribute(
      "href",
      "/orders/ord-1/refund"
    );
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

  it("displays payment error when submitPayment action returns error", async () => {
    const originalPublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_mock";

    let changeHandler: ((event: { error?: { message?: string }; complete: boolean }) => void) | null = null;
    submitPaymentMock.mockResolvedValue({ error: "Payment declined" });

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
        createPaymentMethod: vi.fn().mockResolvedValue({
          paymentMethod: { id: "pm_test_123" },
        }),
      })),
    });

    const { act } = await import("@testing-library/react");

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

      // Simulate card completion
      await act(async () => {
        changeHandler?.({ complete: true });
      });

      // Click Pay Now button
      const payButton = screen.getByRole("button", { name: /pay now/i });

      await act(async () => {
        payButton.click();
      });

      // Verify error is displayed
      await waitFor(() => {
        expect(screen.getByText("Payment declined")).toBeInTheDocument();
      });

      // Button should not be in processing state anymore
      expect(screen.getByRole("button", { name: /pay now/i })).toBeEnabled();
    } finally {
      if (originalPublishableKey === undefined) {
        delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = originalPublishableKey;
      }
      vi.restoreAllMocks();
    }
  });

  it("shows retry payment methods inline after a saved-card payment fails", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    submitPaymentMock.mockResolvedValue({ error: "code: do_not_honor" });

    render(
      <OrderPaymentForm
        orderId="ord-1"
        amount={25.5}
        expiresAt="2099-12-31T23:59:59.000Z"
        savedPaymentMethods={[
          {
            id: "pm_failed",
            brand: "visa",
            label: "Visa •••• 4242",
            last4: "4242",
            expMonth: 8,
            expYear: 2027,
            isDefault: true,
          },
          {
            id: "pm_backup",
            brand: "mastercard",
            label: "Mastercard •••• 8821",
            last4: "8821",
            expMonth: 12,
            expYear: 2026,
          },
        ]}
      />
    );

    const payButton = screen.getByRole("button", { name: /pay now/i });
    await user.click(payButton);

    await waitFor(() => {
      expect(screen.getByText(/we couldn't charge your card/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/code: do_not_honor/i)).toBeInTheDocument();
    expect(screen.getAllByText(/declined/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /try this one/i })).toBeInTheDocument();
  });

  it("polls order status after successful submitPayment action and calls router.refresh", async () => {
    const originalPublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_mock";

    let changeHandler: ((event: { error?: { message?: string }; complete: boolean }) => void) | null = null;
    let statusPollCount = 0;

    const fetchSpy = vi.fn((url: string) => {
      if (url === "/api/orders/ord-1/status") {
        statusPollCount++;
        // Return "processing" on first poll, then "complete" on second
        const orderStatus = statusPollCount === 1 ? "processing" : "complete";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              order: { status: orderStatus },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }

      return Promise.resolve(
        new Response("Not Found", { status: 404 })
      );
    });

    vi.stubGlobal("fetch", fetchSpy);

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
        createPaymentMethod: vi.fn().mockResolvedValue({
          paymentMethod: { id: "pm_test_123" },
        }),
      })),
    });

    const { act } = await import("@testing-library/react");

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

      // Simulate card completion
      await act(async () => {
        changeHandler?.({ complete: true });
      });

      // Click Pay Now button
      const payButton = screen.getByRole("button", { name: /pay now/i });

      await act(async () => {
        payButton.click();
      });

      // Wait for submitPayment server action call
      await waitFor(() => {
        expect(submitPaymentMock).toHaveBeenCalledWith(
          "ord-1",
          {},
          expect.any(FormData)
        );
      });

      // Wait for polling to complete (verify we polled at least twice)
      await waitFor(() => {
        expect(statusPollCount).toBeGreaterThanOrEqual(2);
      }, { timeout: 5000 });

      // Verify router.refresh was called when order status became complete
      expect(routerRefreshMock).toHaveBeenCalled();

      // Verify no error is displayed
      expect(screen.queryByText(/Payment declined/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Payment failed/)).not.toBeInTheDocument();
    } finally {
      if (originalPublishableKey === undefined) {
        delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = originalPublishableKey;
      }
      vi.restoreAllMocks();
    }
  });
});
