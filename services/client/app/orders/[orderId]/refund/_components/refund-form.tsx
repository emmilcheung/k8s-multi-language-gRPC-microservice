"use client";

import { useActionState, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { requestRefund } from "@/app/actions/orders";

const REFUND_REASONS = [
  "Can't attend — schedule changed",
  "Bought by mistake",
  "Found a different option",
  "Event was rescheduled or moved",
  "Something else",
] as const;

export function RefundForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(requestRefund.bind(null, orderId), {});
  const [reason, setReason] = useState<(typeof REFUND_REASONS)[number]>(REFUND_REASONS[0]);
  const [details, setDetails] = useState("");
  const finalReason = useMemo(
    () => (details.trim().length > 0 ? `${reason}: ${details.trim()}` : reason),
    [reason, details]
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="reason" value={finalReason} />
      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-ink">Reason for refund</h2>
        <div role="radiogroup" aria-label="Refund reason options" className="flex flex-col gap-2">
          {REFUND_REASONS.map((option) => {
            const selected = option === reason;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setReason(option)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? "border-accent bg-accent-soft text-ink"
                    : "border-line bg-card text-mute hover:border-accent/50"
                }`}
              >
                <span
                  className={`inline-flex size-3 rounded-full border ${
                    selected ? "border-accent bg-accent" : "border-line"
                  }`}
                />
                <span>{option}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="details" className="text-sm font-medium text-ink">
          Add details (optional)
        </label>
        <textarea
          id="details"
          rows={3}
          value={details}
          onChange={(event) => setDetails(event.currentTarget.value)}
          placeholder="Share context for your request."
          className="w-full rounded-lg border border-line bg-subtle px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/50"
        />
      </div>
      {state?.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      {state?.success && <p role="status" className="text-sm text-ok">{state.success}</p>}
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
