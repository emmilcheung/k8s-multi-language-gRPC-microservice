"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { initiateTransfer } from "@/app/actions/orders";

export function TransferForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(initiateTransfer.bind(null, orderId), {});

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="recipient" className="text-sm font-medium text-ink">
        Recipient email
      </label>
      <input
        id="recipient"
        name="recipient"
        type="email"
        required
        placeholder="friend@example.com"
        className="h-10 rounded-lg border border-line bg-subtle px-3 text-sm outline-none focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/50"
      />
      {state?.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent disabled:opacity-50"
      >
        {pending ? <><Loader2 className="size-4 animate-spin" />Sending…</> : "Send transfer"}
      </button>
    </form>
  );
}

