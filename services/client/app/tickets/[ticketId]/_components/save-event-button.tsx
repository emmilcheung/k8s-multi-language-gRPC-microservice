"use client";
// _components/save-event-button.tsx — Togglable save/unsave button for buyer users.

import { useActionState } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button-variants";
import type { SavedEventState } from "@/app/actions/saved-events";

interface SaveEventButtonProps {
  eventId: string;
  initialSaved: boolean;
  saveAction: (prev: SavedEventState, formData: FormData) => Promise<SavedEventState>;
  unsaveAction: (prev: SavedEventState, formData: FormData) => Promise<SavedEventState>;
}

export function SaveEventButton({
  eventId,
  initialSaved,
  saveAction,
  unsaveAction,
}: SaveEventButtonProps) {
  const [saveState, saveDispatch, savePending] = useActionState(saveAction, {
    savedByMe: initialSaved,
  });
  const [unsaveState, unsaveDispatch, unsavePending] = useActionState(unsaveAction, {
    savedByMe: initialSaved,
  });

  // Derive current saved state from whichever action ran last, falling back to initial.
  const isSaved =
    saveState.savedByMe !== undefined && saveState.savedByMe !== initialSaved
      ? saveState.savedByMe
      : unsaveState.savedByMe !== undefined && unsaveState.savedByMe !== initialSaved
        ? unsaveState.savedByMe
        : initialSaved;

  const pending = savePending || unsavePending;
  const error = saveState.error ?? unsaveState.error;

  return (
    <div className="flex flex-col gap-1">
      {isSaved ? (
        <form action={unsaveDispatch}>
          <input type="hidden" name="eventId" value={eventId} />
          <button
            type="submit"
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
        </form>
      ) : (
        <form action={saveDispatch}>
          <input type="hidden" name="eventId" value={eventId} />
          <button
            type="submit"
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
        </form>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
