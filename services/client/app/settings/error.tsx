"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

interface SettingsErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function SettingsError({ error, reset }: SettingsErrorProps) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 rounded-xl border border-line bg-bg p-6">
      <div className="inline-flex size-10 items-center justify-center rounded bg-destructive/10 text-destructive">
        <AlertTriangle className="size-5" />
      </div>

      <div className="space-y-1">
        <h2 className="font-sans text-xl font-extrabold tracking-tight">Unable to load settings</h2>
        <p className="text-sm text-mute">
          {error.message || "Something went wrong while loading your settings."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={reset} className={cn(buttonVariants())}>Try again</button>
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
          Back to home
        </Link>
      </div>
    </div>
  );
}