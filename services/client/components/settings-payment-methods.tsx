"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import type { SavedPaymentMethod } from "@/lib/types";
import {
  deletePaymentMethodAction,
  setDefaultPaymentMethodAction,
} from "@/app/actions/settings";
import { SettingsAddPaymentMethodForm } from "@/components/settings-add-payment-method-form";

interface SettingsPaymentMethodsProps {
  initialPaymentMethods: SavedPaymentMethod[];
}

function formatPaymentMethodLabel(method: SavedPaymentMethod): string {
  if (method.label) return method.label;
  if (method.last4) {
    return `${method.brand?.toUpperCase() ?? "Saved method"} •••• ${method.last4}`;
  }
  return method.brand?.toUpperCase() ?? "Saved method";
}

function formatPaymentMethodBadge(method: SavedPaymentMethod): string {
  const brand = method.brand?.trim().toLowerCase();
  if (brand === "visa") return "VISA";
  if (brand === "mastercard") return "MC";
  if (brand === "apple pay") return "AP";
  if (brand) return brand.slice(0, 2).toUpperCase();
  return "PM";
}

export function SettingsPaymentMethods({
  initialPaymentMethods,
}: SettingsPaymentMethodsProps) {
  const [, startServerActionTransition] = useTransition();
  const [paymentMethods, setPaymentMethods] = useState(initialPaymentMethods);
  const [error, setError] = useState<string | null>(null);
  const [pendingMethodId, setPendingMethodId] = useState<string | null>(null);

  const runServerAction = <T,>(action: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    startServerActionTransition(() => {
      void action().then(resolve, reject);
    });
  });

  const handleSaved = (paymentMethod: SavedPaymentMethod) => {
    setError(null);
    setPaymentMethods((current) => {
      const remaining = current
        .filter((method) => method.id !== paymentMethod.id)
        .map((method) => paymentMethod.isDefault ? { ...method, isDefault: false } : method);
      return [paymentMethod, ...remaining];
    });
  };

  const handleSetDefault = async (methodId: string) => {
    setError(null);
    setPendingMethodId(methodId);

    const formData = new FormData();
    formData.set("methodId", methodId);

    const result = await runServerAction(() => setDefaultPaymentMethodAction(formData));
    setPendingMethodId(null);

    if (result.error) {
      setError(result.error);
      return;
    }

    if (result.paymentMethod) {
      setPaymentMethods((current) => current.map((method) => (
        method.id === result.paymentMethod?.id
          ? result.paymentMethod
          : { ...method, isDefault: false }
      )));
    }
  };

  const handleDelete = async (methodId: string) => {
    setError(null);
    setPendingMethodId(methodId);

    const formData = new FormData();
    formData.set("methodId", methodId);

    const result = await runServerAction(() => deletePaymentMethodAction(formData));
    setPendingMethodId(null);

    if (result.error) {
      setError(result.error);
      return;
    }

    if (result.deletedMethodId) {
      setPaymentMethods((current) => current.filter((method) => method.id !== result.deletedMethodId));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-xl border border-line bg-subtle px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">Saved cards and wallets</p>
          <p className="text-xs text-mute">
            Used for ticket purchases and fast checkout.
          </p>
        </div>
        <div className="text-xs text-mute">{paymentMethods.length} saved</div>
      </div>

      <SettingsAddPaymentMethodForm onSaved={handleSaved} />

      {error && (
        <p className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {paymentMethods.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-5 text-sm text-mute">
          No saved payment methods yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {paymentMethods.map((method, index) => {
            const pending = pendingMethodId === method.id;

            return (
              <div
                key={method.id}
                className={cn(
                  "flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between",
                  index < paymentMethods.length - 1 && "border-b border-line"
                )}
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-7 min-w-11 items-center justify-center rounded-md border border-line bg-subtle px-2 text-[10px] font-semibold tracking-[0.12em] text-mute">
                    {formatPaymentMethodBadge(method)}
                  </span>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-ink">{formatPaymentMethodLabel(method)}</p>
                      {method.isDefault ? (
                        <Badge className="text-xs" tone="neutral">
                          Default
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-mute">
                      {method.expMonth && method.expYear
                        ? `Exp ${String(method.expMonth).padStart(2, "0")}/${method.expYear}`
                        : "Expiry not available"}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {!method.isDefault && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void handleSetDefault(method.id)}
                      className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
                    >
                      Set default
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void handleDelete(method.id)}
                    className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-destructive")}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
