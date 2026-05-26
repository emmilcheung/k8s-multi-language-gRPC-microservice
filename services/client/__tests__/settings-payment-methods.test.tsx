import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPaymentMethods } from "@/components/settings-payment-methods";

const setDefaultPaymentMethodActionMock = vi.fn();
const deletePaymentMethodActionMock = vi.fn();

vi.mock("@/app/actions/settings", async () => {
  const actual = await vi.importActual<typeof import("@/app/actions/settings")>("@/app/actions/settings");
  return {
    ...actual,
    setDefaultPaymentMethodAction: (...args: unknown[]) => setDefaultPaymentMethodActionMock(...args),
    deletePaymentMethodAction: (...args: unknown[]) => deletePaymentMethodActionMock(...args),
  };
});

vi.mock("@/components/settings-add-payment-method-form", () => ({
  SettingsAddPaymentMethodForm: ({ onSaved }: { onSaved?: (paymentMethod: {
    id: string;
    brand?: string;
    label?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
    isDefault?: boolean;
  }) => void }) => (
    <button
      type="button"
      onClick={() => onSaved?.({
        id: "pm-new",
        brand: "visa",
        label: "Visa •••• 4242",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
        isDefault: true,
      })}
    >
      Mock save payment method
    </button>
  ),
}));

describe("SettingsPaymentMethods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a saved payment method to the visible list immediately", async () => {
    const user = userEvent.setup();

    render(<SettingsPaymentMethods initialPaymentMethods={[]} />);

    expect(screen.getByText(/no saved payment methods yet/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /mock save payment method/i }));

    expect(screen.queryByText(/no saved payment methods yet/i)).not.toBeInTheDocument();
    expect(screen.getByText("Visa •••• 4242")).toBeVisible();
    expect(screen.getByText(/^default$/i)).toBeVisible();
  });

  it("updates the default badge immediately after setting a new default", async () => {
    const user = userEvent.setup();
    setDefaultPaymentMethodActionMock.mockResolvedValue({
      paymentMethod: {
        id: "pm-2",
        brand: "mastercard",
        label: "Mastercard •••• 5555",
        last4: "5555",
        expMonth: 10,
        expYear: 2031,
        isDefault: true,
      },
    });

    render(
      <SettingsPaymentMethods
        initialPaymentMethods={[
          { id: "pm-1", label: "Visa •••• 4242", last4: "4242", isDefault: true },
          { id: "pm-2", label: "Mastercard •••• 5555", last4: "5555", isDefault: false },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: /set default/i }));

    await waitFor(() => expect(setDefaultPaymentMethodActionMock).toHaveBeenCalledTimes(1));

    const defaultBadges = screen.getAllByText(/^default$/i);
    expect(defaultBadges).toHaveLength(1);
    expect(within(screen.getByText("Mastercard •••• 5555").closest("div")!.parentElement!).getByText(/^default$/i)).toBeVisible();
  });

  it("removes a deleted payment method immediately", async () => {
    const user = userEvent.setup();
    deletePaymentMethodActionMock.mockResolvedValue({ deletedMethodId: "pm-1" });

    render(
      <SettingsPaymentMethods
        initialPaymentMethods={[
          { id: "pm-1", label: "Visa •••• 4242", last4: "4242", isDefault: true },
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => expect(deletePaymentMethodActionMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/no saved payment methods yet/i)).toBeVisible();
    expect(screen.queryByText("Visa •••• 4242")).not.toBeInTheDocument();
  });
});
