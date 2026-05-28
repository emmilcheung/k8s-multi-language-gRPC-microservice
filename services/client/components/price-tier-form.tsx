"use client";
// components/price-tier-form.tsx — Inline form to add a price tier to a draft seating plan.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tag, AlertCircle, Loader2, Plus } from "lucide-react";
import type { PlanState } from "@/app/actions/venues";
import type { PriceTier } from "@/lib/types";

interface PriceTierFormProps {
  action: (_prev: PlanState, formData: FormData) => Promise<PlanState>;
  tiers: PriceTier[];
}

const initialState: PlanState = {};

export function PriceTierForm({ action, tiers }: PriceTierFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <div className="glass rounded-2xl p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold">Price Tiers</h3>
        <p className="text-sm text-mute">
          Named price levels assigned to sections (e.g. Floor $200, Upper $80).
        </p>
      </div>

      {tiers.length > 0 && (
        <ul className="flex flex-col gap-2">
          {tiers.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between rounded-xl bg-subtle px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <Tag className="w-3.5 h-3.5 text-accent shrink-0" />
                <span className="font-medium">{t.name}</span>
              </span>
              <span className="font-mono text-accent">${parseFloat(t.price).toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="h-px bg-line" />

      <form action={formAction} className="flex flex-col gap-3">
        {state?.error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2.5"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{state.error}</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="tierName"
            className="text-xs font-medium text-mute uppercase tracking-wider"
          >
            Tier name
          </Label>
          <Input
            id="tierName"
            name="tierName"
            type="text"
            required
            placeholder="Floor"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor="tierPrice"
            className="text-xs font-medium text-mute uppercase tracking-wider"
          >
            Price (USD)
          </Label>
          <Input
            id="tierPrice"
            name="tierPrice"
            type="number"
            min="0"
            step="0.01"
            required
            placeholder="75.00"
          />
        </div>

        <Button
          type="submit"
          variant="outline"
          className="w-full gap-2"
          disabled={pending}
        >
          {pending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Adding…
            </>
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Add Tier
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
