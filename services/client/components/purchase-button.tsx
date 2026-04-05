"use client";
// components/purchase-button.tsx — Client Component that submits createOrder.
// Full-width violet CTA with ShoppingCart icon and glow on hover.
// Supports an optional `maxQuantity` prop for GA tickets with quota; when > 1,
// shows a quantity stepper so the buyer can purchase multiple units at once.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShoppingCart, Loader2, AlertCircle } from "lucide-react";
import { createOrder } from "@/app/actions/orders";
import type { OrderState } from "@/app/actions/orders";

interface PurchaseButtonProps {
  ticketId: string;
  /**
   * Maximum quantity the buyer can select (defaults to 1).
   * When > 1, a quantity stepper is shown above the CTA.
   */
  maxQuantity?: number;
}

const initialState: OrderState = {};

export function PurchaseButton({ ticketId, maxQuantity = 1 }: PurchaseButtonProps) {
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

      {/* Quantity stepper — only shown when quota > 1 */}
      {maxQuantity > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quantity" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Quantity
          </Label>
          <Input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            max={maxQuantity}
            defaultValue={1}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Up to {maxQuantity} per order
          </p>
        </div>
      )}

      {/* Hidden quantity=1 for single-unit tickets (keeps server action contract stable). */}
      {maxQuantity <= 1 && (
        <input type="hidden" name="quantity" value="1" />
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
