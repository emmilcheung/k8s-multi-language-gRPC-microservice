"use client";

import { useFormStatus } from "react-dom";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

/** Submit button for a revoke form; disabled while the request is in flight. */
export function RevokeButton({ appName }: { appName: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={`Revoke access for ${appName}`}
      className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}
    >
      Revoke
    </button>
  );
}
