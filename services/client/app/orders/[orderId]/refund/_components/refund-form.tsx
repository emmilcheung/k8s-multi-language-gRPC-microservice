"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { requestRefund } from "@/app/actions/orders";

export function RefundForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(requestRefund.bind(null, orderId), {});

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label htmlFor="reason" className="text-sm font-medium text-ink">
        Refund reason
      </label>
      <textarea
        id="reason"
        name="reason"
        required
        rows={4}
        placeholder="Please share why you are requesting a refund."
        className="w-full rounded-lg border border-line bg-subtle px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/50"
      />
      {state?.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent disabled:opacity-50"
      >
        {pending ? <><Loader2 className="size-4 animate-spin" />Submitting…</> : "Request refund"}
      </button>
    </form>
  );
}

