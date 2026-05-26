"use client";
// components/activate-plan-button.tsx — Client Component that activates a seating
// plan through a same-origin route handler and reloads the page on success.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Zap } from "lucide-react";

interface ActivatePlanButtonProps {
  planId: string;
  label?: string;
}

interface RouteErrorBody {
  error?: {
    message?: string;
  };
}

export function ActivatePlanButton({ planId, label = "Activate Plan" }: ActivatePlanButtonProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleClick = async () => {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/seating-plans/${planId}/activate`, {
        method: "POST",
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as RouteErrorBody | null;
        setError(body?.error?.message ?? "Failed to activate plan.");
        setPending(false);
        return;
      }

      location.reload();
    } catch {
      setError("Failed to activate plan.");
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
      <Button type="button" disabled={pending} className="gap-2 self-start" onClick={() => void handleClick()}>
        {pending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Zap className="w-4 h-4" />
        )}
        {pending ? "Activating…" : label}
      </Button>
    </div>
  );
}
