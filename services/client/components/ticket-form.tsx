"use client";
// components/ticket-form.tsx — Client Component for creating/editing tickets.
// Glass card with Lucide icon-prefixed inputs and rich error state.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileText, DollarSign, AlertCircle, Loader2, CheckCircle } from "lucide-react";
import type { TicketState } from "@/app/actions/tickets";

interface TicketFormProps {
  action: (_prev: TicketState, formData: FormData) => Promise<TicketState>;
  defaultTitle?: string;
  defaultPrice?: number;
  submitLabel?: string;
}

const initialState: TicketState = {};

export function TicketForm({
  action,
  defaultTitle = "",
  defaultPrice,
  submitLabel = "Create Ticket",
}: TicketFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  const isEdit = submitLabel === "Update Ticket";

  return (
    <div className="glass rounded-2xl w-full max-w-md p-8 flex flex-col gap-6">
      {/* Heading */}
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">{submitLabel}</h2>
        <p className="text-sm text-muted-foreground">
          {isEdit ? "Update your listing details below." : "Fill in the details to list your ticket on the marketplace."}
        </p>
      </div>

      <div className="h-px bg-white/6" />

      <form action={formAction} className="flex flex-col gap-4">
        {/* Error alert */}
        {state?.error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{state.error}</span>
          </div>
        )}

        {/* Title */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Title
          </Label>
          <div className="relative">
            <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="title"
              name="title"
              type="text"
              required
              placeholder="Concert at Madison Square Garden"
              defaultValue={defaultTitle}
              className="pl-9"
            />
          </div>
        </div>

        {/* Price */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="price" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Price (USD)
          </Label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="price"
              name="price"
              type="number"
              step="0.01"
              min="0.01"
              required
              placeholder="9.99"
              defaultValue={defaultPrice}
              className="pl-9"
            />
          </div>
        </div>

        {/* Submit */}
        <Button
          type="submit"
          className="w-full gap-2 bg-primary hover:bg-primary/90 text-primary-foreground mt-1"
          disabled={pending}
        >
          {pending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <CheckCircle className="w-4 h-4" />
              {submitLabel}
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
