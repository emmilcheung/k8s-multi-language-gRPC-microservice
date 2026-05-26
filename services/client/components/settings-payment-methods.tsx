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
    <>
      <SettingsAddPaymentMethodForm onSaved={handleSaved} />

      {error && (
        <p className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {paymentMethods.length === 0 ? (
        <p className="rounded border border-dashed border-border p-4 text-sm text-muted-foreground">
          No saved payment methods yet.
        </p>
      ) : (
        paymentMethods.map((method) => {
          const pending = pendingMethodId === method.id;

          return (
            <div
              key={method.id}
              className="flex flex-col gap-3 rounded border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">{formatPaymentMethodLabel(method)}</p>
                  {method.isDefault && <Badge className="text-xs">Default</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {method.expMonth && method.expYear
                    ? `Expires ${String(method.expMonth).padStart(2, "0")}/${method.expYear}`
                    : "Expiry not available"}
                </p>
              </div>

              <div className="flex gap-2">
                {!method.isDefault && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void handleSetDefault(method.id)}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
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
        })
      )}
    </>
  );
}
