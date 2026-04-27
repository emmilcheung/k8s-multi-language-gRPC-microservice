"use client";
// components/activate-plan-button.tsx — Client Component that submits the
// activatePlan Server Action via useActionState, displaying inline errors and a
// loading state while the request is in-flight.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Zap } from "lucide-react";
import type { PlanState } from "@/app/actions/venues";

interface ActivatePlanButtonProps {
  action: (_prev: PlanState, formData: FormData) => Promise<PlanState>;
  label?: string;
}

export function ActivatePlanButton({ action, label = "Activate Plan" }: ActivatePlanButtonProps) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      {state?.error && (
        <p className="text-sm text-destructive flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="gap-2 self-start">
        {pending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Zap className="w-4 h-4" />
        )}
        {pending ? "Activating…" : label}
      </Button>
    </form>
  );
}
