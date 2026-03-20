"use client";
// components/purchase-button.tsx — Client Component that submits createOrder.
// Full-width violet CTA with ShoppingCart icon and glow on hover.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { ShoppingCart, Loader2, AlertCircle } from "lucide-react";
import { createOrder } from "@/app/actions/orders";
import type { OrderState } from "@/app/actions/orders";

interface PurchaseButtonProps {
  ticketId: string;
}

const initialState: OrderState = {};

export function PurchaseButton({ ticketId }: PurchaseButtonProps) {
  const boundAction = createOrder.bind(null, ticketId);
  const [state, formAction, pending] = useActionState(boundAction, initialState);

  return (
    <form action={formAction} className="w-full flex flex-col gap-3">
      {state?.error && (
        <div
          role="alert"
          className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{state.error}</span>
        </div>
      )}
      <Button
        type="submit"
        className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground glow-violet"
        disabled={pending}
      >
        {pending ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Processing…
          </>
        ) : (
          <>
            <ShoppingCart className="w-4 h-4" />
            Purchase Ticket
          </>
        )}
      </Button>
    </form>
  );
}
