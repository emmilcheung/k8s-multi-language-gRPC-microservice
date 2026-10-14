"use client";
// components/organizer/account-switcher.tsx — Picks which organizer account the
// console acts for. The choice is remembered per browser by a Server Action.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { selectOrganizerAccount } from "@/app/actions/accounts";

interface AccountSwitcherProps {
  accounts: { id: string; name: string }[];
  selectedId: string;
}

export function AccountSwitcher({ accounts, selectedId }: AccountSwitcherProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="organizer-account" className="sr-only">
        Organizer account
      </label>
      <select
        id="organizer-account"
        value={selectedId}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(async () => {
            const result = await selectOrganizerAccount(next);
            setError(result.error ?? null);
            if (!result.error) router.refresh();
          });
        }}
        className="h-8 rounded-md border border-line bg-page px-2 text-sm text-ink"
      >
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
