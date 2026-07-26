"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type HoldTimerRibbonProps = {
  expiresAt: string;
  tone?: "accent" | "warn";
  onExpire?: () => void;
  className?: string;
};

// Pre-compute initial remaining outside component to avoid calling Date.now during render
function computeInitialRemaining(expiresAt: string): number {
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

export function HoldTimerRibbon({
  expiresAt,
  tone = "accent",
  onExpire,
  className,
}: HoldTimerRibbonProps) {
  const [remaining, setRemaining] = useState<number | null>(null);

  // Kept in a ref so a new inline onExpire callback does not restart the timer.
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  // A single interval owns both the countdown and the one-shot expiry callback.
  // The first tick is deferred (setTimeout 0) rather than run inline so the
  // server-rendered and first client-rendered markup stay identical.
  useEffect(() => {
    let expired = false;

    const tick = () => {
      const next = computeInitialRemaining(expiresAt);
      setRemaining(next);
      if (next === 0 && !expired) {
        expired = true;
        clearInterval(interval);
        onExpireRef.current?.();
      }
    };

    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);

    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [expiresAt]);

  // Avoid hydration mismatch
  if (remaining === null) {
    const initial = computeInitialRemaining(expiresAt);
    const minutes = Math.floor(initial / 1000 / 60);
    const seconds = Math.floor((initial / 1000) % 60);
    const display = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    return (
      <div
        className={cn(
          "flex items-center justify-between gap-4 px-4 py-2.5 rounded-md",
          "bg-accent-soft text-accent",
          className
        )}
      >
        <span className="text-xs uppercase tracking-wider">Holding seats</span>
        <span className="font-mono tabular-nums text-base font-medium">
          {display}
        </span>
      </div>
    );
  }

  const minutes = Math.floor(remaining / 1000 / 60);
  const seconds = Math.floor((remaining / 1000) % 60);
  const display = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  // Determine tone: auto-escalate to "warn" when < 2 min
  const effectiveTone = remaining < 120_000 ? "warn" : tone;
  const bgClass = effectiveTone === "warn" ? "bg-warn-soft" : "bg-accent-soft";
  const textClass = effectiveTone === "warn" ? "text-warn" : "text-accent";

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-2.5 rounded-md",
        bgClass,
        textClass,
        className
      )}
    >
      <span className="text-xs uppercase tracking-wider">Holding seats</span>
      <span className="font-mono tabular-nums text-base font-medium">
        {display}
      </span>
    </div>
  );
}
