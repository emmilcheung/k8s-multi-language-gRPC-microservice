"use client";
// _components/save-event-button.tsx — Togglable save/unsave button for buyer users.

import { useEffect, useState, useTransition } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button-variants";
import { getSavedState, saveEvent, unsaveEvent } from "@/app/actions/saved-events";

interface SaveEventButtonProps {
  eventId: string;
  initialSaved?: boolean;
}

export function SaveEventButton({ eventId, initialSaved }: SaveEventButtonProps) {
  const [isSaved, setIsSaved] = useState(initialSaved ?? false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    getSavedState(eventId).then((r) => { if (active) setIsSaved(r.savedByMe); });
    return () => { active = false; };
  }, [eventId]);

  const handleToggle = () => {
    startTransition(async () => {
      const result = isSaved
        ? await unsaveEvent(eventId, { savedByMe: isSaved }, new FormData())
        : await saveEvent(eventId, { savedByMe: isSaved }, new FormData());

      if (result.error) {
        setError(result.error);
        return;
      }

      setError(undefined);
      if (result.savedByMe !== undefined) setIsSaved(result.savedByMe);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      {isSaved ? (
        <button
          type="button"
          onClick={handleToggle}
          disabled={pending}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "gap-2 w-full",
            pending && "opacity-60 cursor-not-allowed"
          )}
        >
          <BookmarkCheck className="size-3.5 text-accent" />
          Saved
        </button>
      ) : (
        <button
          type="button"
          onClick={handleToggle}
          disabled={pending}
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "gap-2 w-full",
            pending && "opacity-60 cursor-not-allowed"
          )}
        >
          <Bookmark className="size-3.5" />
          Save event
        </button>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
