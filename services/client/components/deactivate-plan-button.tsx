"use client";
// components/deactivate-plan-button.tsx — Client Component that deactivates a
// seating plan through a same-origin route handler and reloads on success.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, PowerOff } from "lucide-react";

interface DeactivatePlanButtonProps {
  planId: string;
}

interface RouteErrorBody {
  error?: {
    message?: string;
  };
}

export function DeactivatePlanButton({ planId }: DeactivatePlanButtonProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/seating-plans/${planId}/deactivate`, {
        method: "POST",
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as RouteErrorBody | null;
        setError(body?.error?.message ?? "Failed to deactivate plan.");
        setPending(false);
        return;
      }

      location.reload();
    } catch {
      setError("Failed to deactivate plan.");
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="text-sm text-destructive flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => void handleClick()}
        className="gap-2 self-start border-destructive/40 text-destructive hover:bg-destructive/10"
      >
        {pending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <PowerOff className="w-4 h-4" />
        )}
        {pending ? "Deactivating…" : "Deactivate Plan"}
      </Button>
    </div>
  );
}
