"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, CopyPlus, Loader2 } from "lucide-react";
import type { TicketState } from "@/app/actions/tickets";

interface ReplacePlanButtonProps {
  action: (_prev: TicketState, formData: FormData) => Promise<TicketState>;
}

export function ReplacePlanButton({ action }: ReplacePlanButtonProps) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="flex flex-col gap-2">
      {state?.error && (
        <p className="text-sm text-destructive flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {state.error}
        </p>
      )}
      <Button type="submit" variant="outline" disabled={pending} className="gap-2 self-start">
        {pending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <CopyPlus className="w-4 h-4" />
        )}
        {pending ? "Creating replacement…" : "Create Replacement Plan"}
      </Button>
    </form>
  );
}
