"use client";
// components/order-payment-form.tsx — Stub "Pay Now" Client Component.
// Glass card with large amount display, lock icon security note, two action buttons.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Lock, AlertCircle, CreditCard, Loader2, X, Clock } from "lucide-react";
import { submitPayment, cancelOrder } from "@/app/actions/orders";
import type { OrderState } from "@/app/actions/orders";

interface OrderPaymentFormProps {
  orderId: string;
  amount: number;
  expiresAt: string;
}

const initialState: OrderState = {};

export function OrderPaymentForm({ orderId, amount, expiresAt }: OrderPaymentFormProps) {
  const boundPay = submitPayment.bind(null, orderId);
  const boundCancel = cancelOrder.bind(null, orderId);

  const [payState, payAction, payPending] = useActionState(boundPay, initialState);
  const [cancelState, cancelAction, cancelPending] = useActionState(
    boundCancel,
    initialState
  );

  const isPending = payPending || cancelPending;
  const error = payState?.error ?? cancelState?.error;

  return (
    <div className="glass rounded-2xl w-full p-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <CreditCard className="w-4 h-4" />
          Complete Payment
        </div>
        {/* Big amount */}
        <p className="text-4xl font-bold tracking-tight gradient-text">
          ${amount.toFixed(2)}
        </p>
      </div>

      <div className="h-px bg-white/6" />

      {/* Expiry */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Clock className="w-4 h-4 shrink-0 text-amber-400/70" />
        <span>
          Order expires:{" "}
          <span className="text-amber-400/90 font-medium">
            {new Date(expiresAt).toLocaleString()}
          </span>
        </span>
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Security note */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-white/3 rounded-xl px-3 py-2.5 border border-white/6">
        <Lock className="w-3.5 h-3.5 text-primary/60 shrink-0" />
        Your payment is processed securely. We never store card details.
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <form action={payAction} className="w-full">
          <Button
            type="submit"
            className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
            disabled={isPending}
          >
            {payPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing…
              </>
            ) : (
              <>
                <CreditCard className="w-4 h-4" />
                Pay Now
              </>
            )}
          </Button>
        </form>

        <form action={cancelAction} className="w-full">
          <Button
            type="submit"
            variant="ghost"
            className="w-full gap-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            disabled={isPending}
          >
            {cancelPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Cancelling…
              </>
            ) : (
              <>
                <X className="w-4 h-4" />
                Cancel Order
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
