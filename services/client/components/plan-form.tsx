"use client";
// components/plan-form.tsx — Client Component for creating a seating plan.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Layers, Users, AlertCircle, Loader2, CheckCircle } from "lucide-react";
import type { PlanState } from "@/app/actions/venues";

interface PlanFormProps {
  action: (_prev: PlanState, formData: FormData) => Promise<PlanState>;
  venueId: string;
  submitLabel?: string;
}

const initialState: PlanState = {};

export function PlanForm({
  action,
  venueId,
  submitLabel = "Create Seating Plan",
}: PlanFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <div className="glass rounded-2xl w-full max-w-md p-8 flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">{submitLabel}</h2>
        <p className="text-sm text-muted-foreground">
          Define the plan name and seat limit per order.
        </p>
      </div>

      <div className="h-px bg-white/6" />

      <form action={formAction} className="flex flex-col gap-4">
        {/* Hidden venue ID */}
        <input type="hidden" name="venueId" value={venueId} />

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

        {/* Plan name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Plan Name
          </Label>
          <div className="relative">
            <Layers className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="name"
              name="name"
              type="text"
              required
              placeholder="Main Floor 2026"
              className="pl-9"
            />
          </div>
        </div>

        {/* Max seats per order */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="maxSeatsPerOrder" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Max Seats per Order
          </Label>
          <div className="relative">
            <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              id="maxSeatsPerOrder"
              name="maxSeatsPerOrder"
              type="number"
              min="1"
              max="20"
              defaultValue={10}
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
