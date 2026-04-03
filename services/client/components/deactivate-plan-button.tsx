"use client";
// components/deactivate-plan-button.tsx — Client Component that submits the
// deactivatePlan Server Action, with inline error and loading state.

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, PowerOff } from "lucide-react";
import type { PlanState } from "@/app/actions/venues";

interface DeactivatePlanButtonProps {
  action: (_prev: PlanState, formData: FormData) => Promise<PlanState>;
}

export function DeactivatePlanButton({ action }: DeactivatePlanButtonProps) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      {state?.error && (
        <p className="text-sm text-destructive flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {state.error}
        </p>
      )}
      <Button
        type="submit"
        variant="outline"
        disabled={pending}
        className="gap-2 self-start border-destructive/40 text-destructive hover:bg-destructive/10"
      >
        {pending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <PowerOff className="w-4 h-4" />
        )}
        {pending ? "Deactivating…" : "Deactivate Plan"}
      </Button>
    </form>
  );
}
