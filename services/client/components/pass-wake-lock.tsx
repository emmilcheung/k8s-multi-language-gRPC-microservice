"use client";

import { useEffect } from "react";

type WakeLockSentinelLike = {
  release: () => Promise<void>;
};

type WakeLockLike = {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
};

export function PassWakeLock() {
  useEffect(() => {
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock?.request) {
      return;
    }

    void wakeLock
      .request("screen")
      .then((lock) => {
        if (cancelled) {
          void lock.release();
          return;
        }
        sentinel = lock;
      })
      .catch(() => {
        // Wake Lock is best-effort; browser/platform may deny silently.
      });

    return () => {
      cancelled = true;
      if (sentinel) {
        void sentinel.release().catch(() => {});
      }
    };
  }, []);

  return null;
}
