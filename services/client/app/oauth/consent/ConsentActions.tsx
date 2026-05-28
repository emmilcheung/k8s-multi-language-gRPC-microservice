"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

interface ConsentActionsProps {
  requestId: string;
}

export function ConsentActions({ requestId }: ConsentActionsProps) {
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitConsent(approve: boolean) {
    setPending(approve ? "approve" : "deny");
    setError(null);

    try {
      const res = await fetch(`/api/oauth/consent/${requestId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ approve }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error((body.message as string | undefined) ?? "Request failed");
      }

      const data = await res.json() as { redirectUrl: string };
      window.location.href = data.redirectUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="text-sm text-destructive text-center">{error}</p>
      )}
      <div className="flex gap-3">
        <Button
          variant="outline"
          className="flex-1 border-line text-mute hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50"
          disabled={pending !== null}
          onClick={() => submitConsent(false)}
        >
          {pending === "deny" ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <XCircle data-icon="inline-start" />
          )}
          Deny
        </Button>
        <Button
          className="flex-1 font-semibold"
          disabled={pending !== null}
          onClick={() => submitConsent(true)}
        >
          {pending === "approve" ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <CheckCircle data-icon="inline-start" />
          )}
          Allow Access
        </Button>
      </div>
    </div>
  );
}
