"use client";
// components/admin/reason-form.tsx — Form shell for platform admin actions.
// Every admin action carries a reason, so the submit button stays disabled
// until one is typed. The action rechecks it on the server.

import { useActionState, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AdminActionState } from "@/app/actions/admin";

interface ReasonFormProps {
  action: (prev: AdminActionState, formData: FormData) => Promise<AdminActionState>;
  submitLabel: string;
  children: ReactNode;
}

export function ReasonForm({ action, submitLabel, children }: ReasonFormProps) {
  const [state, formAction, pending] = useActionState(action, {} as AdminActionState);
  const [reason, setReason] = useState("");

  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.message && (
        <Alert>
          <CheckCircle />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {children}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="reason" className="text-xs font-medium uppercase tracking-wider text-mute">
          Reason
        </Label>
        <Textarea
          id="reason"
          name="reason"
          required
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this needed? It is kept in the audit history."
        />
      </div>
      <Button type="submit" disabled={pending || reason.trim() === ""} className="self-start">
        {pending && <Loader2 className="size-4 animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
