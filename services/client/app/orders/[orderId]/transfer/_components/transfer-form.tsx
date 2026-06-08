"use client";

import { useMemo, useState } from "react";
import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { initiateTransfer } from "@/app/actions/orders";

export function TransferForm({ orderId, credentialId }: { orderId: string; credentialId: string }) {
  const [state, formAction, pending] = useActionState(initiateTransfer.bind(null, orderId), {});
  const [note, setNote] = useState("");
  const notePreview = useMemo(() => note.trim(), [note]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="credentialId" value={credentialId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="recipient" className="text-sm font-medium text-ink">
          Their email
        </label>
        <input
          id="recipient"
          name="recipient"
          type="email"
          required
          placeholder="friend@example.com"
          className="h-10 rounded-lg border border-line bg-subtle px-3 text-sm outline-none focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/50"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="note" className="text-sm font-medium text-ink">
          Add a note
        </label>
        <textarea
          id="note"
          name="note"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          placeholder="Optional message for your friend."
          className="w-full rounded-lg border border-line bg-subtle px-3 py-2 text-sm outline-none focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/50"
        />
        {notePreview ? (
          <p className="text-xs text-mute">Preview: “{notePreview}”</p>
        ) : null}
      </div>
      {state?.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      {state?.success && <p role="status" className="text-sm text-ok">{state.success}</p>}
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
